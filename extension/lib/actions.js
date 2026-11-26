// Applies a validated plan to the browser and records how to reverse it.
// Every step is best-effort: one failing tab never aborts the rest.

import { isBookmarkable } from './plan.js';
import { openTabsLightly } from './light-open.js';
import { buildSession, deleteSession, saveableTabs, saveSession } from './sessions.js';

const ROOT_FOLDER = 'Decltr';
const LEGACY_ROOT_FOLDER = 'Declt'; // the folder name before the product was renamed

const attempt = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

async function liveTabs(ids, windowId) {
  const found = await Promise.all(ids.map((id) => attempt(() => chrome.tabs.get(id))));
  return found.filter((t) => t && t.windowId === windowId).sort((a, b) => a.index - b.index);
}

/** Title and color of each group the given tabs belong to (groups vanish when emptied). */
async function groupInfo(tabs) {
  const info = new Map();
  for (const t of tabs) {
    if (t.groupId === -1 || info.has(t.groupId)) continue;
    const g = await attempt(() => chrome.tabGroups.get(t.groupId));
    if (g) info.set(t.groupId, { title: g.title ?? '', color: g.color, collapsed: Boolean(g.collapsed) });
  }
  return info;
}

const snapshotOf = (tabs, info) =>
  tabs.map((t) => ({ id: t.id, index: t.index, groupId: t.groupId, group: info.get(t.groupId) ?? null }));

const tabWord = (n) => `${n} tab${n === 1 ? '' : 's'}`;

/** How many tabs a plan's undo would reopen. Big numbers reopen lightly and take a while. */
export const tabsToReopen = (undo) => (undo?.steps ?? []).filter((s) => s.type === 'reopen').reduce((n, s) => n + s.closed.length, 0);

/** True when a plan saves bookmarks, which needs the optional "bookmarks" permission. */
export const needsBookmarks = (plan) => (plan?.actions ?? []).some((a) => a.type === 'bookmark');

export async function applyPlan(plan, { windowId }) {
  // Without bookmark access, a "bookmark, then close" plan would close tabs that were never saved.
  // So refuse the whole plan before changing anything.
  if (needsBookmarks(plan) && !globalThis.chrome?.bookmarks) {
    throw Object.assign(new Error('Decltr was not allowed to create bookmarks, so nothing was changed.'), { code: 'no_bookmarks' });
  }
  const steps = [];
  const stats = { grouped: 0, ungrouped: 0, closed: 0, moved: 0, bookmarked: 0, archived: 0, skipped: 0 };
  const notes = [];
  const ctx = { windowId, steps, stats, notes };

  for (const action of plan.actions) {
    try {
      if (action.type === 'group') await doGroup(action, ctx);
      else if (action.type === 'ungroup') await doUngroup(action, ctx);
      else if (action.type === 'close') await doClose(action, ctx);
      else if (action.type === 'move_to_new_window') await doMove(action, ctx);
      else if (action.type === 'bookmark') await doBookmark(action, ctx);
      else if (action.type === 'archive') await doArchive(action, ctx);
    } catch (err) {
      notes.push(`Could not finish "${action.type}": ${err?.message ?? 'unknown error'}`);
    }
  }
  return { stats, notes, undo: { windowId, steps, createdAt: Date.now() } };
}

// ---- group ------------------------------------------------------------------

async function doGroup(action, ctx) {
  const { windowId, steps, stats } = ctx;
  const tabs = (await liveTabs(action.tabIds, windowId)).filter((t) => !t.pinned);
  stats.skipped += action.tabIds.length - tabs.length;
  if (tabs.length === 0) return;

  const ids = tabs.map((t) => t.id);
  const before = snapshotOf(tabs, await groupInfo(tabs));

  // Reuse a group with the same title so repeated runs merge instead of duplicating.
  const existing = await chrome.tabGroups.query({ windowId });
  const wanted = action.name.trim().toLowerCase();
  const match = existing.find((g) => (g.title ?? '').trim().toLowerCase() === wanted);

  if (match) {
    await chrome.tabs.group({ groupId: match.id, tabIds: ids });
  } else {
    const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: action.name, color: action.color });
  }
  steps.push({ type: 'regroup', windowId, before });
  stats.grouped += ids.length;
}

// Ungrouping is undone by the same "restore group membership" step that undoes grouping.
async function doUngroup(action, ctx) {
  const { windowId, steps, stats } = ctx;
  const tabs = (await liveTabs(action.tabIds, windowId)).filter((t) => t.groupId !== -1);
  stats.skipped += action.tabIds.length - tabs.length;
  if (tabs.length === 0) return;

  const before = snapshotOf(tabs, await groupInfo(tabs));
  await chrome.tabs.ungroup(tabs.map((t) => t.id));
  steps.push({ type: 'regroup', windowId, before });
  stats.ungrouped += tabs.length;
}

async function undoRegroup(step) {
  const alive = (await liveTabs(step.before.map((b) => b.id), step.windowId)).map((t) => t.id);
  const before = step.before.filter((b) => alive.includes(b.id));
  if (before.length === 0) return;

  await attempt(() => chrome.tabs.ungroup(before.map((b) => b.id)));
  for (const b of [...before].sort((x, y) => x.index - y.index)) {
    await attempt(() => chrome.tabs.move(b.id, { index: b.index }));
  }
  await regroupByOldGroup(before, step.windowId);
}

/** Put tabs back into the groups they were in, if those groups still exist. */
async function regroupByOldGroup(before, windowId) {
  const byGroup = new Map();
  for (const b of before) {
    if (b.groupId === -1 || b.groupId === undefined) continue;
    if (!byGroup.has(b.groupId)) byGroup.set(b.groupId, []);
    byGroup.get(b.groupId).push(b);
  }
  for (const [groupId, members] of byGroup) {
    const tabIds = members.map((m) => m.id);
    const group = await attempt(() => chrome.tabGroups.get(groupId));
    if (group && group.windowId === windowId) {
      await attempt(() => chrome.tabs.group({ groupId, tabIds }));
    } else {
      // Chrome deletes a group when its last tab leaves, so rebuild it.
      const created = await attempt(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
      const info = members[0].group;
      if (created !== null && info) {
        await attempt(() => chrome.tabGroups.update(created, { title: info.title, color: info.color }));
        if (info.collapsed) await attempt(() => chrome.tabGroups.update(created, { collapsed: true }));
      }
    }
  }
}

// ---- close ------------------------------------------------------------------

async function doClose(action, ctx) {
  const { windowId, steps, stats, notes } = ctx;
  const tabs = await liveTabs(action.tabIds, windowId);
  stats.skipped += action.tabIds.length - tabs.length;
  if (tabs.length === 0) return;

  // Closing every tab would close the window itself, so leave a blank tab behind.
  const all = await chrome.tabs.query({ windowId });
  const closing = new Set(tabs.map((t) => t.id));
  if (all.every((t) => closing.has(t.id))) {
    const blank = await chrome.tabs.create({ windowId, active: true });
    steps.push({ type: 'remove', ids: [blank.id] });
    notes.push('Left a new tab open so the window stays.');
  }

  const groups = await groupInfo(tabs);
  const closed = tabs.map((t) => ({
    url: t.url || t.pendingUrl || '',
    index: t.index,
    pinned: t.pinned,
    groupId: t.groupId,
    group: groups.get(t.groupId) ?? null,
  }));

  await chrome.tabs.remove([...closing]);
  steps.push({ type: 'reopen', windowId, closed });
  stats.closed += tabs.length;
}

/**
 * Reopen closed tabs where they were, and put them back in their groups. Many tabs reopen lightly
 * (see light-open.js), so undoing a big close cannot use up the computer's memory.
 */
async function undoReopen(step, { onProgress } = {}) {
  const closed = [...step.closed].filter((c) => c.url).sort((a, b) => a.index - b.index);
  const { ids } = await openTabsLightly(closed.map((c) => ({ url: c.url, pinned: c.pinned, index: c.index })), { windowId: step.windowId, onProgress });

  // Tabs that were in the same group go back together, once their IDs are final.
  const byGroup = new Map();
  closed.forEach((c, k) => {
    if (ids[k] === null || c.groupId === -1 || !c.group) return;
    if (!byGroup.has(c.groupId)) byGroup.set(c.groupId, { info: c.group, ids: [] });
    byGroup.get(c.groupId).ids.push(ids[k]);
  });
  const collapseAfter = []; // rebuilt groups that were collapsed; collapsed once all their tabs are back
  for (const [oldId, { info, ids: tabIds }] of byGroup) {
    const stillThere = await attempt(() => chrome.tabGroups.get(oldId));
    if (stillThere && stillThere.windowId === step.windowId) {
      await attempt(() => chrome.tabs.group({ groupId: oldId, tabIds }));
      continue;
    }
    const created = await attempt(() => chrome.tabs.group({ tabIds, createProperties: { windowId: step.windowId } }));
    if (created === null) continue;
    await attempt(() => chrome.tabGroups.update(created, { title: info.title, color: info.color }));
    if (info.collapsed) collapseAfter.push(created);
  }
  // Collapsing earlier would hide tabs that are still being added to the group.
  for (const groupId of collapseAfter) await attempt(() => chrome.tabGroups.update(groupId, { collapsed: true }));
}

// ---- archive: save as a session, then close ---------------------------------

/**
 * Save tabs as a session marked as an archive, then close them. A tab that is in use right now (active
 * or playing sound) is left open, even if it was picked. Undo reopens the tabs and deletes the session.
 */
async function doArchive(action, ctx) {
  const { windowId, steps, stats, notes } = ctx;
  const live = (await liveTabs(action.tabIds, windowId)).filter((t) => !t.active && !t.audible);
  const groups = new Map((await chrome.tabGroups.query({ windowId })).map((g) => [g.id, { title: g.title ?? '', color: g.color, collapsed: Boolean(g.collapsed) }]));
  const tabs = saveableTabs(live.map((t) => ({
    id: t.id, url: t.url || t.pendingUrl || '', title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned, groupId: t.groupId, lastAccessed: t.lastAccessed,
  })));
  stats.skipped += action.tabIds.length - tabs.length;
  if (tabs.length === 0) return;

  const session = buildSession({ name: action.name, nameSource: 'user', kind: 'archive', tabs, groups });
  await saveSession(session);
  steps.push({ type: 'unsave', sessionId: session.id });
  const before = stats.closed;
  await doClose({ type: 'close', tabIds: tabs.map((t) => t.id) }, ctx);
  stats.archived += stats.closed - before;
  stats.closed = before;
  notes.push(`Saved as the session \u201c${session.name}\u201d. Open it again from Sessions.`);
}

// ---- move to new window -----------------------------------------------------

async function doMove(action, ctx) {
  const { windowId, steps, stats, notes } = ctx;
  let tabs = await liveTabs(action.tabIds, windowId);
  stats.skipped += action.tabIds.length - tabs.length;

  // Moving every tab would close this window. Keep the active (or last) tab here.
  const all = await chrome.tabs.query({ windowId });
  if (tabs.length >= all.length) {
    const keep = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
    tabs = tabs.filter((t) => t.id !== keep.id);
    stats.skipped += 1;
    notes.push('Kept one tab in this window so it does not close.');
  }
  if (tabs.length === 0) return;

  const groups = await groupInfo(tabs);
  const before = snapshotOf(tabs, groups);

  const win = await chrome.windows.create({ tabId: tabs[0].id, focused: false });
  const rest = tabs.slice(1).map((t) => t.id);
  if (rest.length) await chrome.tabs.move(rest, { windowId: win.id, index: -1 });

  // Keep the grouping the tabs had, now inside the new window.
  for (const [oldId, info] of groups) {
    const ids = before.filter((b) => b.groupId === oldId).map((b) => b.id);
    const created = await attempt(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } }));
    if (created !== null) await attempt(() => chrome.tabGroups.update(created, { title: info.title, color: info.color }));
  }

  steps.push({ type: 'moveBack', windowId, before });
  stats.moved += tabs.length;
}

async function undoMoveBack(step) {
  const alive = await Promise.all(step.before.map((b) => attempt(() => chrome.tabs.get(b.id))));
  const present = step.before.filter((b, i) => alive[i]);
  for (const b of [...present].sort((x, y) => x.index - y.index)) {
    await attempt(() => chrome.tabs.ungroup(b.id));
    await attempt(() => chrome.tabs.move(b.id, { windowId: step.windowId, index: b.index }));
  }
  await regroupByOldGroup(present, step.windowId);
}

// ---- bookmark ---------------------------------------------------------------

async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = root.children ?? [];
  return (kids.find((k) => k.folderType === 'other') ?? kids.find((k) => k.id === '2') ?? kids[kids.length - 1]).id;
}

async function ensureFolder(parentId, title, created) {
  const kids = await chrome.bookmarks.getChildren(parentId);
  const hit = kids.find((k) => !k.url && k.title === title);
  if (hit) return hit.id;
  const folder = await chrome.bookmarks.create({ parentId, title });
  created.push(folder.id);
  return folder.id;
}

/** The top-level bookmarks folder. One created under the old name is renamed, so earlier bookmarks stay together. */
async function ensureRootFolder(parentId, created) {
  const kids = await chrome.bookmarks.getChildren(parentId);
  const current = kids.find((k) => !k.url && k.title === ROOT_FOLDER);
  if (current) return current.id;
  const previous = kids.find((k) => !k.url && k.title === LEGACY_ROOT_FOLDER);
  if (previous) {
    await chrome.bookmarks.update(previous.id, { title: ROOT_FOLDER });
    return previous.id;
  }
  const folder = await chrome.bookmarks.create({ parentId, title: ROOT_FOLDER });
  created.push(folder.id);
  return folder.id;
}

async function doBookmark(action, ctx) {
  const { windowId, steps, stats } = ctx;
  const tabs = (await liveTabs(action.tabIds, windowId)).filter((t) => isBookmarkable(t.url));
  stats.skipped += action.tabIds.length - tabs.length;
  if (tabs.length === 0) return;

  const createdFolders = [];
  const createdBookmarks = [];
  const rootId = await ensureRootFolder(await otherBookmarksId(), createdFolders);
  const folderId = await ensureFolder(rootId, action.folder, createdFolders);
  const known = new Set((await chrome.bookmarks.getChildren(folderId)).map((b) => b.url));

  for (const t of tabs) {
    if (known.has(t.url)) {
      stats.skipped += 1;
      continue;
    }
    const bm = await chrome.bookmarks.create({ parentId: folderId, title: t.title || t.url, url: t.url });
    createdBookmarks.push(bm.id);
    known.add(t.url);
    stats.bookmarked += 1;
  }
  steps.push({ type: 'unbookmark', bookmarks: createdBookmarks, folders: createdFolders });
}

async function undoUnbookmark(step) {
  for (const id of step.bookmarks) await attempt(() => chrome.bookmarks.remove(id));
  // Newest folder first; remove() refuses non-empty folders, which keeps pre-existing content safe.
  for (const id of [...step.folders].reverse()) await attempt(() => chrome.bookmarks.remove(id));
}

// ---- undo -------------------------------------------------------------------

/** Reverse a plan, newest step first. `onProgress({ done, total })` reports tabs being reopened. */
export async function undoPlan(undo, { onProgress } = {}) {
  for (const step of [...undo.steps].reverse()) {
    if (step.type === 'regroup') await undoRegroup(step);
    else if (step.type === 'reopen') await undoReopen(step, { onProgress });
    else if (step.type === 'unsave') await attempt(() => deleteSession(step.sessionId));
    else if (step.type === 'moveBack') await undoMoveBack(step);
    else if (step.type === 'unbookmark') await undoUnbookmark(step);
    else if (step.type === 'remove') await attempt(() => chrome.tabs.remove(step.ids));
  }
}

// ---- wording ----------------------------------------------------------------

export function describeResult({ stats }) {
  const parts = [];
  if (stats.ungrouped) parts.push(`ungrouped ${tabWord(stats.ungrouped)}`);
  if (stats.grouped) parts.push(`grouped ${tabWord(stats.grouped)}`);
  if (stats.moved) parts.push(`moved ${tabWord(stats.moved)} to a new window`);
  if (stats.bookmarked) parts.push(`bookmarked ${tabWord(stats.bookmarked)}`);
  if (stats.archived) parts.push(`archived ${tabWord(stats.archived)}`);
  if (stats.closed) parts.push(`closed ${tabWord(stats.closed)}`);
  if (parts.length === 0) return 'Nothing needed to change.';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

export function hasUndoableChanges({ stats }) {
  return stats.grouped + stats.ungrouped + stats.moved + stats.bookmarked + stats.closed + (stats.archived ?? 0) > 0;
}
