// Keeps an opened session up to date: while a session's window is open, changes to its
// tabs and groups are written back to the saved session.
//
// A window is "linked" to a session when the session is opened into it. Links live in
// chrome.storage.session, because window IDs only mean something until the browser closes.
//
// Safety rules (each one exists to stop a sync from damaging a saved session):
//  - A window that is closing is never synced. Chrome removes its tabs one by one, and
//    saving halfway through would store a partial session.
//  - A window with nothing worth saving is never synced, so clearing a window or closing
//    the last real tab cannot empty a session.
//  - Syncing only replaces tabs and groups. It never touches the name, and it never
//    recreates a session that was deleted.

import { buildSession, updateSessionContent, withLock } from './sessions.js';

export const LINKS_KEY = 'decltr.links';
export const LIVE_SETTING = 'liveSessions';
const LINK_LOCK = 'decltr-links';

const attempt = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

// ---- links -------------------------------------------------------------------

/** { [windowId]: sessionId } */
export async function getLinks() {
  return (await chrome.storage.session.get(LINKS_KEY))[LINKS_KEY] ?? {};
}

const mutateLinks = (fn) =>
  withLock(LINK_LOCK, async () => {
    const next = fn({ ...(await getLinks()) });
    await chrome.storage.session.set({ [LINKS_KEY]: next });
  });

/** A session follows at most one window, and a window follows at most one session. */
export const linkWindow = (windowId, sessionId) =>
  mutateLinks((links) => {
    for (const [w, s] of Object.entries(links)) if (s === sessionId) delete links[w];
    links[windowId] = sessionId;
    return links;
  });

export const unlinkWindow = (windowId) =>
  mutateLinks((links) => {
    delete links[windowId];
    return links;
  });

export const unlinkSession = (sessionId) =>
  mutateLinks((links) => {
    for (const [w, s] of Object.entries(links)) if (s === sessionId) delete links[w];
    return links;
  });

/** Forget every link. Used when live syncing is switched off, so turning it back on never resumes stale windows. */
export const unlinkAll = () => mutateLinks(() => ({}));

/** The window a session is live in, or null. Forgets windows that no longer exist. */
export async function liveWindowFor(sessionId) {
  const entry = Object.entries(await getLinks()).find(([, s]) => s === sessionId);
  if (!entry) return null;
  const windowId = Number(entry[0]);
  if (await attempt(() => chrome.windows.get(windowId))) return windowId;
  await unlinkWindow(windowId);
  return null;
}

export async function isLiveEnabled() {
  return (await chrome.storage.local.get({ [LIVE_SETTING]: true }))[LIVE_SETTING] !== false;
}

// ---- syncing -----------------------------------------------------------------

/** Write the current state of a linked window back to its session. Returns what happened. */
export async function syncWindow(windowId) {
  const sessionId = (await getLinks())[windowId];
  if (!sessionId) return 'not-linked';
  if (!(await isLiveEnabled())) return 'disabled';
  if (!(await attempt(() => chrome.windows.get(windowId)))) {
    await unlinkWindow(windowId);
    return 'window-gone';
  }

  const [tabs, groupList] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
  const built = buildSession({
    name: 'x',
    tabs: tabs.map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', title: t.title, favIconUrl: t.favIconUrl, pinned: t.pinned, groupId: t.groupId })),
    groups: new Map(groupList.map((g) => [g.id, { title: g.title ?? '', color: g.color, collapsed: Boolean(g.collapsed) }])),
  });
  if (built.tabs.length === 0) return 'skipped-empty';

  const result = await updateSessionContent(sessionId, { tabs: built.tabs, groups: built.groups });
  if (result === 'missing') await unlinkWindow(windowId);
  return result;
}

/** Debounced syncing driven by browser events. */
export function createTracker({ debounceMs = 2000 } = {}) {
  const timers = new Map();
  const closing = new Set();

  const cancel = (windowId) => {
    clearTimeout(timers.get(windowId));
    timers.delete(windowId);
  };

  const markClosing = (windowId) => {
    closing.add(windowId);
    cancel(windowId);
    // windows.onRemoved normally clears this; the timeout covers a window that never finishes closing.
    setTimeout(() => closing.delete(windowId), 30_000).unref?.();
  };

  async function schedule(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0 || closing.has(windowId)) return;
    if (!(windowId in (await getLinks())) || !(await isLiveEnabled())) return;
    if (closing.has(windowId)) return; // the window began closing while we were checking
    cancel(windowId);
    const timer = setTimeout(() => {
      timers.delete(windowId);
      if (!closing.has(windowId)) syncWindow(windowId).catch(() => {});
    }, debounceMs);
    timer.unref?.();
    timers.set(windowId, timer);
  }

  /** Run every pending sync now. Used by tests and before the worker goes idle. */
  async function flush() {
    const pending = [...timers.keys()];
    pending.forEach(cancel);
    for (const windowId of pending) if (!closing.has(windowId)) await syncWindow(windowId);
  }

  function register(api = chrome) {
    api.tabs.onCreated.addListener((tab) => schedule(tab.windowId));
    api.tabs.onRemoved.addListener((tabId, info) => (info.isWindowClosing ? markClosing(info.windowId) : schedule(info.windowId)));
    api.tabs.onUpdated.addListener((tabId, change, tab) => {
      const relevant = ['url', 'title', 'pinned', 'groupId', 'favIconUrl'].some((k) => k in change) || change.status === 'complete';
      if (relevant) schedule(tab.windowId);
    });
    api.tabs.onMoved.addListener((tabId, info) => schedule(info.windowId));
    api.tabs.onAttached.addListener((tabId, info) => schedule(info.newWindowId));
    api.tabs.onDetached.addListener((tabId, info) => schedule(info.oldWindowId));
    for (const event of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
      api.tabGroups[event].addListener((group) => schedule(group.windowId));
    }
    api.windows.onRemoved.addListener((windowId) => {
      cancel(windowId);
      closing.delete(windowId);
      unlinkWindow(windowId).catch(() => {});
    });
  }

  return { schedule, cancel, flush, register, markClosing, pending: () => [...timers.keys()] };
}
