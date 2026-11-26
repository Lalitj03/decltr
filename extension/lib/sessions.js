// Saved sessions: a snapshot of a window (tabs, order, pinned state, groups) that
// can be reopened later in any window. Stored in chrome.storage.local, i.e. only in
// this browser profile. Nothing here is sent to the Decltr server or to Gemini.

import { clean } from './plan.js';
import { openTabsLightly, weakTitle } from './light-open.js';

// Each session is stored under its own key, so an automatic update rewrites one session
// instead of all of them. LEGACY_KEY held every session in one array and is migrated.
export const LEGACY_KEY = 'declt.sessions'; // first version: every session in one array
const OLD_PREFIX = 'declt.session.'; // per-session keys, before the product was renamed to Decltr
export const SESSION_PREFIX = 'decltr.session.';
export const isSessionKey = (key) => key === LEGACY_KEY || key.startsWith(OLD_PREFIX) || key.startsWith(SESSION_PREFIX);
const keyOf = (id) => `${SESSION_PREFIX}${id}`;
const NAME_SOURCES = ['default', 'user', 'ai'];
export const MAX_NAME = 60;
const MAX_URL = 8192;
const MAX_SESSIONS = 200;
const MAX_TABS_PER_SESSION = 5000;
const KINDS = ['archive']; // a session made by "Archive old tabs"; anything else is a normal session
/** When a tab was last used, as Chrome reports it, or undefined when unknown. */
const usedAt = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const attempt = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/** Pages an extension can reopen. Anything else (javascript:, data:, other extensions) is skipped. */
export function isRestorableUrl(url) {
  return typeof url === 'string' && url.length <= MAX_URL && (/^(https?|file):\/\//i.test(url) || /^chrome:\/\//i.test(url) || url === 'about:blank');
}

/** A tab with nothing worth saving. */
export function isBlankUrl(url) {
  return !url || /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/i.test(url);
}

const isOwnPage = (url) => typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id) && String(url).startsWith(`chrome-extension://${chrome.runtime.id}/`);

/** The tabs of a snapshot that a session can hold. Save & clear closes exactly these. */
export function saveableTabs(tabs) {
  return tabs.filter((t) => isRestorableUrl(t.url) && !isBlankUrl(t.url) && !isOwnPage(t.url));
}

export function defaultSessionName(now = new Date()) {
  const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  return `Session ${when}`;
}

/**
 * Build a session from window tabs. `groups` maps groupId -> {title, color, collapsed}.
 * Groups are stored by position so they survive being restored with new IDs.
 */
export function buildSession({ name, nameSource, tabs, groups, kind, now = Date.now(), id = crypto.randomUUID() }) {
  const kept = saveableTabs(tabs);
  const groupIndex = new Map();
  const outGroups = [];
  const outTabs = kept.map((t) => {
    let g = -1;
    if (t.groupId !== -1 && t.groupId !== undefined && groups.has(t.groupId)) {
      if (!groupIndex.has(t.groupId)) {
        const info = groups.get(t.groupId);
        groupIndex.set(t.groupId, outGroups.length);
        outGroups.push({ title: clean(info.title, 40), color: info.color, collapsed: Boolean(info.collapsed) });
      }
      g = groupIndex.get(t.groupId);
    }
    return {
      url: t.url,
      title: clean(t.title, 120),
      favIcon: /^https?:\/\//i.test(t.favIconUrl ?? '') && t.favIconUrl.length <= 300 ? t.favIconUrl : '',
      pinned: Boolean(t.pinned),
      g: t.pinned ? -1 : g,
      ...(usedAt(t.lastAccessed) ? { used: usedAt(t.lastAccessed) } : {}),
    };
  });
  const given = clean(name, MAX_NAME);
  return {
    id,
    name: given || defaultSessionName(new Date(now)),
    nameSource: given ? (nameSource ?? 'user') : 'default',
    ...(KINDS.includes(kind) ? { kind } : {}),
    createdAt: now,
    updatedAt: now,
    tabs: outTabs,
    groups: outGroups,
  };
}

/** Validate whatever is in storage. Corrupt entries are dropped, never trusted. */
export function sanitizeSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, MAX_SESSIONS)) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.tabs)) continue;
    const groups = (Array.isArray(s.groups) ? s.groups : []).slice(0, 100).map((g) => ({
      title: clean(g?.title, 40),
      color: GROUP_COLORS.includes(g?.color) ? g.color : 'grey',
      collapsed: Boolean(g?.collapsed),
    }));
    const tabs = s.tabs
      .filter((t) => t && isRestorableUrl(t.url))
      .slice(0, MAX_TABS_PER_SESSION)
      .map((t) => ({
        url: t.url,
        title: clean(t.title, 120),
        favIcon: typeof t.favIcon === 'string' && /^https?:\/\//i.test(t.favIcon) && t.favIcon.length <= 300 ? t.favIcon : '',
        pinned: Boolean(t.pinned),
        g: Number.isInteger(t.g) && t.g >= 0 && t.g < groups.length && !t.pinned ? t.g : -1,
        ...(usedAt(t.used) ? { used: usedAt(t.used) } : {}),
      }));
    if (tabs.length === 0) continue;
    out.push({
      id: s.id,
      name: clean(s.name, MAX_NAME) || 'Untitled session',
      nameSource: NAME_SOURCES.includes(s.nameSource) ? s.nameSource : 'user',
      ...(KINDS.includes(s.kind) ? { kind: s.kind } : {}),
      createdAt: Number(s.createdAt) || 0,
      updatedAt: Number(s.updatedAt) || Number(s.createdAt) || 0,
      tabs,
      groups,
    });
  }
  return out;
}

// ---- storage ---------------------------------------------------------------

let fallbackQueue = Promise.resolve();

/**
 * Run fn while holding a named lock. Web Locks make this exclusive across the side
 * panel, other windows' panels and the background worker, which all write sessions.
 */
export function withLock(name, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(name, fn);
  const run = fallbackQueue.then(fn, fn);
  fallbackQueue = run.catch(() => {});
  return run;
}

const LOCK = 'decltr-sessions';

let migratedFor = null;

/**
 * Move sessions saved under older key names to the current ones. An entry is removed only after its
 * copy has been written, and an entry that cannot be read is left where it is rather than deleted.
 * Runs once per page or worker.
 */
async function migrateLegacy() {
  if (migratedFor === chrome) return;
  const all = await chrome.storage.local.get(null);
  const entries = {};
  const moved = [];
  const adopt = (key, sessions) => {
    if (sessions.length === 0) return; // unreadable: leave it where it is
    for (const session of sessions) {
      if (!(keyOf(session.id) in all)) entries[keyOf(session.id)] = session; // never overwrite a newer copy
    }
    moved.push(key);
  };
  if (all[LEGACY_KEY] !== undefined) adopt(LEGACY_KEY, sanitizeSessions(all[LEGACY_KEY]));
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(OLD_PREFIX)) adopt(key, sanitizeSessions([value]));
  }
  if (Object.keys(entries).length) await chrome.storage.local.set(entries);
  if (moved.length) await chrome.storage.local.remove(moved);
  migratedFor = chrome;
}

/** Every storage operation goes through here: one writer at a time, legacy data migrated first. */
const locked = (fn) =>
  withLock(LOCK, async () => {
    await migrateLegacy();
    return fn();
  });

const readOne = async (id) => sanitizeSessions([(await chrome.storage.local.get(keyOf(id)))[keyOf(id)]])[0] ?? null;

export const loadSessions = () =>
  locked(async () => {
    const all = await chrome.storage.local.get(null);
    const raw = Object.entries(all).filter(([key]) => key.startsWith(SESSION_PREFIX)).map(([, value]) => value);
    return sanitizeSessions(raw).sort((a, b) => b.createdAt - a.createdAt);
  });

export const saveSession = (session) =>
  locked(async () => {
    try {
      await chrome.storage.local.set({ [keyOf(session.id)]: session });
    } catch {
      throw new Error('Not enough browser storage to save this session. Delete an old session and try again.');
    }
  });

export const deleteSession = (id) => locked(() => chrome.storage.local.remove(keyOf(id)));

/** Rename by hand. Returns the updated session, or null if it no longer exists or the name is empty. */
export const renameSession = (id, name) =>
  locked(async () => {
    const session = await readOne(id);
    const clean_ = clean(name, MAX_NAME);
    if (!session || !clean_) return null;
    const next = { ...session, name: clean_, nameSource: 'user' };
    await chrome.storage.local.set({ [keyOf(id)]: next });
    return next;
  });

/** Apply an AI-suggested name, but only if nobody has named the session in the meantime. */
export const applyAutoName = (id, name) =>
  locked(async () => {
    const session = await readOne(id);
    const clean_ = clean(name, MAX_NAME);
    if (!session || session.nameSource !== 'default' || !clean_) return false;
    await chrome.storage.local.set({ [keyOf(id)]: { ...session, name: clean_, nameSource: 'ai' } });
    return true;
  });

/**
 * Replace a session's tabs and groups, leaving its name and everything else alone.
 * Never creates a session: if it was deleted meanwhile, nothing is written.
 * Returns "updated", "unchanged" or "missing".
 */
export const updateSessionContent = (id, { tabs, groups }) =>
  locked(async () => {
    const session = await readOne(id);
    if (!session) return 'missing';
    const next = keepKnownDetails(tabs, session.tabs);
    const strip = (list) => JSON.stringify(list.map(({ used, ...t }) => t)); // a tab being looked at is not a change worth a write
    if (strip(session.tabs) === strip(next) && JSON.stringify(session.groups) === JSON.stringify(groups)) return 'unchanged';
    await chrome.storage.local.set({ [keyOf(id)]: { ...session, tabs: next, groups, updatedAt: Date.now() } });
    return 'updated';
  });

/**
 * A tab that is not loaded shows only its address as its title, has no icon, and may not know when it
 * was last used. Syncing must not overwrite what the session already knew about that page with less.
 */
export function keepKnownDetails(tabs, known) {
  const byUrl = new Map();
  for (const t of known) if (!byUrl.has(t.url)) byUrl.set(t.url, t);
  return tabs.map((t) => {
    const old = byUrl.get(t.url);
    if (!old) return t;
    const out = { ...t };
    if (weakTitle(t.title, t.url) && old.title && !weakTitle(old.title, old.url)) out.title = old.title;
    if (!t.favIcon && old.favIcon) out.favIcon = old.favIcon;
    if (!t.used && old.used) out.used = old.used;
    return out;
  });
}

// ---- opening ---------------------------------------------------------------

const tabUrl = (t) => t.url || t.pendingUrl || '';

/**
 * Open a session. target "new" uses a fresh window, "here" appends to `windowId`.
 * A window that only holds blank tabs (for example right after Save & clear) has
 * them removed afterwards, so you do not end up with a stray empty tab.
 *
 * Big sessions open lightly (see light-open.js): every tab appears at once, but only the tab you land on
 * and pinned tabs load; the rest load when clicked. `onProgress({ done, total })` reports progress and
 * `signal` stops before the next tab, keeping what has opened (`stopped` is then true).
 */
export async function openSession(session, { target, windowId, signal, onProgress, light } = {}) {
  let targetWindowId = windowId;
  const newWindow = target === 'new';
  if (newWindow) targetWindowId = (await chrome.windows.create({ focused: true })).id;

  const existing = await chrome.tabs.query({ windowId: targetWindowId });
  const relevant = existing.filter((t) => !isOwnPage(tabUrl(t)));
  // Nothing but blank tabs (or nothing at all besides this extension's own page): the window is free to become the session.
  const wasBlank = relevant.every((t) => isBlankUrl(tabUrl(t)));
  const blankIds = wasBlank ? relevant.map((t) => t.id) : [];

  const created = new Array(session.tabs.length).fill(null);
  const failed = [];
  const order = []; // positions in the session that can be opened
  session.tabs.forEach((t, i) => (isRestorableUrl(t.url) ? order.push(i) : failed.push(t.url)));
  const opened = await openTabsLightly(order.map((i) => ({ url: session.tabs[i].url, pinned: session.tabs[i].pinned })), {
    windowId: targetWindowId,
    keepLoaded: (k) => k === 0, // the tab you land on
    ...(light === undefined ? {} : { light }),
    signal,
    onProgress,
  });
  order.forEach((i, k) => (created[i] = opened.ids[k]));
  opened.failed.forEach((k) => failed.push(session.tabs[order[k]].url));
  const createdIds = created.filter((id) => id !== null);
  const base = { windowId: targetWindowId, newWindow, createdIds, failed, wasBlank, stopped: opened.stopped, unloaded: opened.unloaded };

  if (createdIds.length === 0) {
    if (newWindow) await attempt(() => chrome.windows.remove(targetWindowId));
    return { ...base, removedBlank: 0 };
  }

  // Rebuild groups.
  const activeId = createdIds[0];
  for (let gi = 0; gi < session.groups.length; gi++) {
    const members = session.tabs.map((t, i) => (t.g === gi ? created[i] : null)).filter((id) => id !== null);
    if (members.length === 0) continue;
    const groupId = await attempt(() => chrome.tabs.group({ tabIds: members, createProperties: { windowId: targetWindowId } }));
    if (groupId === null) continue;
    const g = session.groups[gi];
    // Chrome will not collapse the group that holds the active tab.
    await attempt(() => chrome.tabGroups.update(groupId, { title: g.title, color: g.color, collapsed: g.collapsed && !members.includes(activeId) }));
  }

  await attempt(() => chrome.tabs.update(activeId, { active: true }));
  if (blankIds.length) await attempt(() => chrome.tabs.remove(blankIds));
  return { ...base, removedBlank: blankIds.length };
}

// ---- opening part of a session ---------------------------------------------

/** True when the session knows when its tabs were last used (sessions saved before this was recorded do not). */
export const knowsLastUse = (session) => session.tabs.some((t) => t.used);

/**
 * The positions of the `count` most recently used tabs (`newest`), or the `count` least recently used,
 * returned in session order. Tabs whose last use is unknown count as the oldest.
 */
export function pickByLastUse(session, { count, newest = true }) {
  const ranked = session.tabs.map((t, i) => ({ i, used: t.used ?? 0 }))
    .sort((a, b) => (newest ? b.used - a.used : a.used - b.used) || a.i - b.i);
  return ranked.slice(0, Math.max(0, count)).map((r) => r.i).sort((a, b) => a - b);
}

/** The positions of the tabs in the given groups (indexes into session.groups; -1 means ungrouped tabs). */
export function pickByGroups(session, groupIndexes) {
  const wanted = new Set(groupIndexes);
  return session.tabs.map((t, i) => (wanted.has(t.g) ? i : null)).filter((i) => i !== null);
}

/**
 * A copy of the session holding only the tabs at `positions`, with its groups renumbered.
 * Opening it opens just those tabs, with their groups.
 */
export function partOfSession(session, positions) {
  const keep = [...new Set(positions)].filter((i) => Number.isInteger(i) && i >= 0 && i < session.tabs.length).sort((a, b) => a - b);
  const groupMap = new Map();
  const groups = [];
  const tabs = keep.map((i) => {
    const t = session.tabs[i];
    if (t.g < 0) return { ...t };
    if (!groupMap.has(t.g)) {
      groupMap.set(t.g, groups.length);
      groups.push({ ...session.groups[t.g] });
    }
    return { ...t, g: groupMap.get(t.g) };
  });
  return { ...session, tabs, groups };
}

/** Reverse openSession: close what it opened. */
export async function undoOpen(info) {
  if (info.newWindow) {
    const closed = await attempt(() => chrome.windows.remove(info.windowId), false);
    if (closed !== false) return;
  }
  const remaining = (await chrome.tabs.query({ windowId: info.windowId })).filter((t) => !info.createdIds.includes(t.id));
  if (remaining.filter((t) => !isOwnPage(tabUrl(t))).length === 0) {
    await attempt(() => chrome.tabs.create({ windowId: info.windowId, active: true }));
  }
  await attempt(() => chrome.tabs.remove(info.createdIds));
}

export function describeSession(session) {
  const n = session.tabs.length;
  const g = session.groups.length;
  return `${n} tab${n === 1 ? '' : 's'}${g ? ` · ${g} group${g === 1 ? '' : 's'}` : ''}`;
}
