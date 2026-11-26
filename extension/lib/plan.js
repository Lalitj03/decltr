// Pure plan logic: validation of server/model output, and the presets that run
// entirely on-device. No chrome.* calls here so it can be unit tested in Node.

export const ACTION_TYPES = ['group', 'ungroup', 'close', 'move_to_new_window', 'bookmark', 'archive'];
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const MAX_ACTIONS = 200; // a big window can have many groups, for example one per website

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

export function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isBookmarkable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Validate a plan against the tabs that exist right now.
 * `liveById` is a Map of tabId -> tab. Unknown ids and malformed actions are dropped.
 */
export function sanitizePlan(raw, liveById) {
  const plan = {
    summary: clean(raw?.summary, 240),
    message: clean(raw?.message, 400),
    actions: [],
  };
  const claimed = { group: new Set(), ungroup: new Set(), move_to_new_window: new Set(), archive: new Set() };
  const list = Array.isArray(raw?.actions) ? raw.actions.slice(0, MAX_ACTIONS) : [];

  for (const a of list) {
    if (!a || !ACTION_TYPES.includes(a.type) || !Array.isArray(a.tabIds)) continue;
    const ids = [];
    for (const id of a.tabIds) {
      if (!Number.isInteger(id) || !liveById.has(id) || ids.includes(id)) continue;
      if (claimed[a.type]?.has(id)) continue;
      // Only tabs that are really in a group can be ungrouped.
      if (a.type === 'ungroup' && (liveById.get(id).groupId ?? -1) === -1) continue;
      ids.push(id);
    }
    if (ids.length === 0) continue;

    const action = { type: a.type, tabIds: ids };
    const reason = clean(a.reason, 140);
    if (reason) action.reason = reason;
    if (a.type === 'group') {
      action.name = clean(a.name, 40) || 'Group';
      action.color = GROUP_COLORS.includes(a.color) ? a.color : 'grey';
    }
    if (a.type === 'bookmark') action.folder = clean(a.folder, 60) || 'Saved tabs';
    if (a.type === 'archive') action.name = clean(a.name, 60) || 'Archived tabs';

    if (claimed[a.type]) ids.forEach((id) => claimed[a.type].add(id));
    plan.actions.push(action);
  }
  return plan;
}

/** Words for the plan header, e.g. "Group 8 tabs · Close 2 tabs". */
export function describeActions(actions) {
  const n = (type) => actions.filter((a) => a.type === type);
  const count = (list) => new Set(list.flatMap((a) => a.tabIds)).size;
  const tabs = (k) => `${k} tab${k === 1 ? '' : 's'}`;
  const parts = [];
  const ungroups = n('ungroup');
  if (ungroups.length) parts.push(`Ungroup ${tabs(count(ungroups))}`);
  const groups = n('group');
  if (groups.length) parts.push(`Group ${tabs(count(groups))} into ${groups.length} group${groups.length === 1 ? '' : 's'}`);
  const moves = n('move_to_new_window');
  if (moves.length) parts.push(`Move ${tabs(count(moves))} to a new window`);
  const marks = n('bookmark');
  if (marks.length) parts.push(`Bookmark ${tabs(count(marks))}`);
  const archives = n('archive');
  if (archives.length) parts.push(`Archive ${tabs(count(archives))}`);
  const closes = n('close');
  if (closes.length) parts.push(`Close ${tabs(count(closes))}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// On-device presets. Each takes the tabs of the window and returns a plan.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_eid$|mc_cid$|igshid$|ref$|ref_src$)/i;

/** Two tabs with the same key are considered the same page. */
export function duplicateKey(url) {
  if (!isBookmarkable(url)) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function siteName(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
    return 'Browser pages';
  } catch {
    return 'Other';
  }
}

export function planGroupBySite(tabs) {
  const bySite = new Map();
  for (const t of tabs) {
    if (t.pinned || t.groupId !== -1) continue; // leave existing groups alone
    const site = siteName(t.url);
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(t.id);
  }
  const actions = [];
  for (const [site, ids] of bySite) {
    if (ids.length < 2) continue;
    actions.push({
      type: 'group',
      name: site.slice(0, 40),
      color: GROUP_COLORS[actions.length % GROUP_COLORS.length],
      tabIds: ids,
    });
  }
  const n = actions.reduce((s, a) => s + a.tabIds.length, 0);
  return {
    summary: actions.length ? `Group ${n} tabs by website.` : '',
    message: actions.length ? '' : 'No website has two or more ungrouped tabs, so there is nothing to group.',
    actions,
  };
}

export function planCloseDuplicates(tabs) {
  const keeper = new Map(); // key -> tab we keep
  const extras = [];
  const rank = (t) => (t.active ? 2 : t.audible ? 1 : 0);

  for (const t of tabs) {
    if (t.pinned) continue;
    const key = duplicateKey(t.url);
    if (!key) continue;
    const current = keeper.get(key);
    if (!current) {
      keeper.set(key, t);
    } else if (rank(t) > rank(current)) {
      extras.push(current);
      keeper.set(key, t);
    } else {
      extras.push(t);
    }
  }
  const actions = extras.length
    ? [{ type: 'close', tabIds: extras.map((t) => t.id), reason: 'Same page is already open in another tab' }]
    : [];
  return {
    summary: extras.length ? `Close ${extras.length} duplicate tab${extras.length === 1 ? '' : 's'} and keep one of each page.` : '',
    message: extras.length ? '' : 'No duplicate tabs found.',
    actions,
  };
}

export function planSaveSession(tabs, now = new Date()) {
  const saveable = tabs.filter((t) => !t.pinned && isBookmarkable(t.url));
  if (saveable.length === 0) {
    return { summary: '', message: 'There are no regular web pages to save in this window.', actions: [] };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const folder = `Session ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const ids = saveable.map((t) => t.id);
  return {
    summary: `Save ${ids.length} tabs as bookmarks, then close them.`,
    message: '',
    actions: [
      { type: 'bookmark', folder, tabIds: ids },
      { type: 'close', tabIds: ids, reason: 'Saved to bookmarks first' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Group management presets (on-device).
// ---------------------------------------------------------------------------

const inGroup = (t) => t.groupId !== -1 && t.groupId !== undefined;

export function planUngroupAll(tabs) {
  const ids = tabs.filter(inGroup).map((t) => t.id);
  return {
    summary: ids.length ? `Take ${ids.length} tab${ids.length === 1 ? '' : 's'} out of their groups. No tabs are closed.` : '',
    message: ids.length ? '' : 'There are no tab groups in this window.',
    actions: ids.length ? [{ type: 'ungroup', tabIds: ids }] : [],
  };
}

/** Dissolve one group but keep its tabs. */
export function planUngroupGroup(tabs, groupId, title) {
  const ids = tabs.filter((t) => t.groupId === groupId).map((t) => t.id);
  const name = clean(title, 40) || 'this group';
  return {
    summary: ids.length ? `Dissolve ${name === 'this group' ? name : `\u201c${name}\u201d`}. Its ${ids.length} tab${ids.length === 1 ? ' stays' : 's stay'} open.` : '',
    message: ids.length ? '' : 'That group no longer has any tabs here.',
    actions: ids.length ? [{ type: 'ungroup', tabIds: ids }] : [],
  };
}

/** Delete a group together with all of its tabs. */
export function planCloseGroup(tabs, groupId, title) {
  const ids = tabs.filter((t) => t.groupId === groupId).map((t) => t.id);
  const name = clean(title, 40) || 'this group';
  return {
    summary: ids.length ? `Close ${name === 'this group' ? name : `\u201c${name}\u201d`} and its ${ids.length} tab${ids.length === 1 ? '' : 's'}.` : '',
    message: ids.length ? '' : 'That group no longer has any tabs here.',
    actions: ids.length ? [{ type: 'close', tabIds: ids, reason: `Part of the group \u201c${name}\u201d` }] : [],
  };
}
