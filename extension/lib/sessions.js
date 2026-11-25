// Saved sessions: a snapshot of a window (tabs, order, pinned state, groups) that
// can be reopened later in any window. Stored in chrome.storage.local, i.e. only in
// this browser profile. Nothing here is sent to the Decltr server or to Gemini.

import { clean } from './plan.js';

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
export function buildSession({ name, nameSource, tabs, groups, now = Date.now(), id = crypto.randomUUID() }) {
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
    };
  });
  const given = clean(name, MAX_NAME);
  return {
    id,
    name: given || defaultSessionName(new Date(now)),
    nameSource: given ? (nameSource ?? 'user') : 'default',
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
      .slice(0, 2000)
      .map((t) => ({
        url: t.url,
        title: clean(t.title, 120),
        favIcon: typeof t.favIcon === 'string' && /^https?:\/\//i.test(t.favIcon) && t.favIcon.length <= 300 ? t.favIcon : '',
        pinned: Boolean(t.pinned),
        g: Number.isInteger(t.g) && t.g >= 0 && t.g < groups.length && !t.pinned ? t.g : -1,
      }));
    if (tabs.length === 0) continue;
    out.push({
      id: s.id,
      name: clean(s.name, MAX_NAME) || 'Untitled session',
      nameSource: NAME_SOURCES.includes(s.nameSource) ? s.nameSource : 'user',
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
    if (JSON.stringify([session.tabs, session.groups]) === JSON.stringify([tabs, groups])) return 'unchanged';
    await chrome.storage.local.set({ [keyOf(id)]: { ...session, tabs, groups, updatedAt: Date.now() } });
    return 'updated';
  });

// ---- opening ---------------------------------------------------------------

const tabUrl = (t) => t.url || t.pendingUrl || '';

/**
 * Open a session. target "new" uses a fresh window, "here" appends to `windowId`.
 * A window that only holds blank tabs (for example right after Save & clear) has
 * them removed afterwards, so you do not end up with a stray empty tab.
 */
export async function openSession(session, { target, windowId }) {
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
  for (let i = 0; i < session.tabs.length; i++) {
    const t = session.tabs[i];
    if (!isRestorableUrl(t.url)) {
      failed.push(t.url);
      continue;
    }
    const tab = await attempt(() => chrome.tabs.create({ windowId: targetWindowId, url: t.url, active: false, pinned: t.pinned }));
    if (tab) created[i] = tab.id;
    else failed.push(t.url);
  }
  const createdIds = created.filter((id) => id !== null);

  if (createdIds.length === 0) {
    if (newWindow) await attempt(() => chrome.windows.remove(targetWindowId));
    return { windowId: targetWindowId, newWindow, createdIds, failed, removedBlank: 0, wasBlank };
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
  return { windowId: targetWindowId, newWindow, createdIds, failed, removedBlank: blankIds.length, wasBlank };
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
