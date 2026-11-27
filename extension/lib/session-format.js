// The shape of a saved session, in one place: checking sessions that come from storage, from a file or from
// another browser; comparing them; merging two copies of the same session; and the export file format.
// Pure: no chrome.* calls, so the extension, the optional server and the tests all use the same code.

import { clean, GROUP_COLORS } from './plan.js';

export const SESSION_LIMITS = Object.freeze({
  sessions: 1000, // per browser, and in the shared store
  tabs: 5000, // per session
  groups: 100,
  name: 60,
  title: 120,
  groupTitle: 40,
  url: 8192,
  fileBytes: 25 * 1024 * 1024, // an import file
});
/** Name sources in rising order of precedence: a name you typed beats an AI suggestion, which beats the date. */
export const NAME_SOURCES = ['default', 'ai', 'user'];
export const KINDS = ['archive']; // a session made by "Archive old tabs"; anything else is a normal session
/** Session and browser IDs that may be used as file names by the server and travel between browsers. */
export const SHARE_ID = /^[A-Za-z0-9-]{8,64}$/;

const time = (v, fallback = 0) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : fallback);
const usedAt = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
const iconOk = (v) => typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 300;

/** Pages an extension can reopen. Anything else (javascript:, data:, other extensions) is skipped. */
export function isRestorableUrl(url) {
  return typeof url === 'string' && url.length <= SESSION_LIMITS.url && (/^(https?|file):\/\//i.test(url) || /^chrome:\/\//i.test(url) || url === 'about:blank');
}

/** Pages Decltr opens from an imported file, which may come from someone else: web pages and local files only. */
export const isImportableUrl = (url) => typeof url === 'string' && url.length <= SESSION_LIMITS.url && /^(https?|file):\/\/\S/i.test(url);

/** A tab with nothing worth saving. */
export function isBlankUrl(url) {
  return !url || /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/i.test(url);
}

/**
 * Check one session from storage, a file or another browser. Returns a clean copy, or null if nothing usable
 * is left. `fromFile` applies the rules for files: only web pages and local files, and no icon addresses,
 * because showing an icon makes the panel contact an address chosen by whoever made the file.
 * `counts.skipped` (if given) is increased by the number of tabs left out.
 */
export function sanitizeSession(s, { fromFile = false, counts } = {}) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.tabs)) return null;
  if (!fromFile && (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > 200)) return null;
  const groups = (Array.isArray(s.groups) ? s.groups : []).slice(0, SESSION_LIMITS.groups).map((g) => ({
    title: clean(g?.title, SESSION_LIMITS.groupTitle),
    color: GROUP_COLORS.includes(g?.color) ? g.color : 'grey',
    collapsed: Boolean(g?.collapsed),
  }));
  const okUrl = fromFile ? isImportableUrl : isRestorableUrl;
  const usable = s.tabs.filter((t) => t && okUrl(t.url));
  const kept = usable.slice(0, SESSION_LIMITS.tabs);
  if (counts) counts.skipped = (counts.skipped ?? 0) + (s.tabs.length - kept.length);
  const tabs = kept.map((t) => ({
    url: t.url,
    title: clean(t.title, SESSION_LIMITS.title),
    favIcon: !fromFile && iconOk(t.favIcon) ? t.favIcon : '',
    pinned: Boolean(t.pinned),
    g: Number.isInteger(t.g) && t.g >= 0 && t.g < groups.length && !t.pinned ? t.g : -1,
    ...(usedAt(t.used) ? { used: usedAt(t.used) } : {}),
  }));
  if (tabs.length === 0) return null;
  const createdAt = time(Number(s.createdAt));
  return {
    ...(fromFile ? {} : { id: s.id }),
    name: clean(s.name, SESSION_LIMITS.name) || 'Untitled session',
    nameSource: NAME_SOURCES.includes(s.nameSource) ? s.nameSource : 'user',
    nameAt: time(Number(s.nameAt), createdAt),
    ...(KINDS.includes(s.kind) ? { kind: s.kind } : {}),
    ...(!fromFile && typeof s.by === 'string' && SHARE_ID.test(s.by) ? { by: s.by } : {}),
    createdAt,
    updatedAt: time(Number(s.updatedAt), createdAt),
    tabs,
    groups,
  };
}

/** Check whatever is in storage. Corrupt entries are dropped, never trusted. */
export function sanitizeSessions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10_000).map((s) => sanitizeSession(s)).filter(Boolean);
}

/** Newest first, the order the Sessions tab shows. */
export const sortSessions = (list) => [...list].sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)));

// ---- comparing -------------------------------------------------------------------------------

/** A short, stable hash of a string (cyrb53). */
export function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${str.length.toString(36)}.${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

const tabsAndGroups = (s) => JSON.stringify([
  s.tabs.map((t) => [t.url, t.title, t.favIcon ?? '', t.pinned ? 1 : 0, t.g, t.used ?? 0]),
  s.groups.map((g) => [g.title, g.color, g.collapsed ? 1 : 0]),
]);

/**
 * Two sessions with the same key hold the same pages in the same groups, whatever their names.
 * Used to spot a session that is "already here" when importing or when two browsers start sharing.
 */
export const contentKey = (s) => hash(JSON.stringify([s.tabs.map((t) => [t.url, t.pinned ? 1 : 0, t.g]), s.groups.map((g) => [g.title, g.color])]));

/** Changes whenever anything that is shared between browsers changes. The ID and the creating browser are left out. */
export const fingerprint = (s) => hash(JSON.stringify([s.name, s.nameSource, s.nameAt ?? s.createdAt, s.kind ?? '', s.createdAt, s.updatedAt]) + tabsAndGroups(s));

const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};

/**
 * Merge two copies of the same session. The name and the content (tabs and groups) are merged separately:
 *  - name: a name you typed beats an AI name, which beats the date name; otherwise the later one wins
 *  - content: the later change wins
 * Ties are broken by the content itself, so the result does not depend on which copy is "a" and which is
 * "b", and merging again changes nothing. Every browser and the server can merge in any order and still
 * end up with the same session.
 */
export function mergeSessions(a, b) {
  const nameOrder = (s) => [NAME_SOURCES.indexOf(s.nameSource), s.nameAt ?? s.createdAt ?? 0, s.name];
  const contentOrder = (s) => [s.updatedAt ?? 0, tabsAndGroups(s)];
  const named = compare(nameOrder(a), nameOrder(b)) >= 0 ? a : b;
  const content = compare(contentOrder(a), contentOrder(b)) >= 0 ? a : b;
  const by = [a.by, b.by].filter(Boolean).sort()[0];
  const kind = a.kind || b.kind;
  return {
    id: a.id,
    name: named.name,
    nameSource: named.nameSource,
    nameAt: named.nameAt ?? named.createdAt ?? 0,
    ...(kind ? { kind } : {}),
    ...(by ? { by } : {}),
    createdAt: Math.min(a.createdAt ?? 0, b.createdAt ?? 0),
    updatedAt: content.updatedAt,
    tabs: content.tabs,
    groups: content.groups,
  };
}

// ---- finding ---------------------------------------------------------------------------------

/** True when every word of the query appears in the session's name, or in one of its tabs' titles or addresses. */
export function matchesQuery(session, query, cache) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  // Sessions are read again for every search, so the text is cached by what it depends on.
  const key = `${session.id}|${session.updatedAt}|${session.nameAt}|${session.name}`;
  let text = cache?.get(key);
  if (text === undefined) {
    text = [session.name, ...session.groups.map((g) => g.title), ...session.tabs.flatMap((t) => [t.title, t.url])].join('\n').toLowerCase();
    if (cache && cache.size > 5000) cache.clear();
    cache?.set(key, text);
  }
  return words.every((w) => text.includes(w));
}

// ---- files -----------------------------------------------------------------------------------

export const FILE_FORMAT = 'decltr-sessions';
export const FILE_VERSION = 1;

/** What an export file holds for one session: everything except IDs and icon addresses. */
function forFile(s) {
  return {
    name: s.name,
    nameSource: s.nameSource,
    nameAt: s.nameAt ?? s.createdAt,
    ...(s.kind ? { kind: s.kind } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    groups: s.groups.map((g) => ({ title: g.title, color: g.color, collapsed: g.collapsed })),
    tabs: s.tabs.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned, g: t.g, ...(t.used ? { used: t.used } : {}) })),
  };
}

/** The export file: readable JSON with a format name and a version, so later versions can still read it. */
export function exportFile(sessions, { app = 'Decltr', browser = '', now = Date.now() } = {}) {
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: new Date(now).toISOString(),
    from: { app, ...(browser ? { browser } : {}) },
    sessions: sessions.map(forFile),
  };
}

/** "Decltr sessions 2026-11-27.json", or "Decltr Lisbon trip 2026-11-27.json" for a single session. */
export function exportFileName(sessions, now = Date.now()) {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const what = sessions.length === 1 ? sessions[0].name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'session' : 'sessions';
  return `Decltr ${what} ${day}.json`;
}

/**
 * Sessions as Markdown links, for notes or a chat: one "##" heading per session and one "###" heading per
 * group. Ungrouped tabs come first under each session, so reading the text back puts every tab where it was.
 */
export function sessionsToMarkdown(sessions) {
  const link = (t) => `- [${(t.title || t.url).replace(/[[\]]/g, '')}](${t.url.replace(/\)/g, '%29').replace(/\s/g, '%20')})`;
  return sessions.map((s) => {
    const lines = [`## ${s.name}`, ''];
    const loose = s.tabs.filter((t) => t.g < 0);
    if (loose.length) lines.push(...loose.map(link), '');
    s.groups.forEach((g, gi) => {
      const tabs = s.tabs.filter((t) => t.g === gi);
      if (tabs.length) lines.push(`### ${g.title || 'Unnamed group'}`, '', ...tabs.map(link), '');
    });
    return lines.join('\n');
  }).join('\n').trimEnd() + '\n';
}

const baseName = (fileName) => clean(String(fileName ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' '), SESSION_LIMITS.name) || 'Imported links';

/**
 * Read an import file: a Decltr export, or a list of links (a OneTab export, Markdown links, or any text
 * with web addresses in it). A file can come from anyone, so everything in it is checked like data from
 * the internet. Returns { ok: true, kind, sessions, skipped, duplicates, notes, from?, exportedAt? } or
 * { ok: false, code, message }. Sessions have no IDs yet.
 */
export function parseImport(text, { fileName = '', now = Date.now() } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, code: 'empty', message: 'That file is empty.' };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (data !== null) return readDecltrFile(data, { now });
  }
  return readLinks(text, { name: baseName(fileName), now });
}

const notSessions = { ok: false, code: 'not_sessions', message: 'This file is not a Decltr export or a list of links.' };

function readDecltrFile(data, { now }) {
  if (!data || typeof data !== 'object' || data.format !== FILE_FORMAT || !Number.isInteger(data.version) || data.version < 1) return notSessions;
  if (data.version > FILE_VERSION) return { ok: false, code: 'newer', message: 'This file was made by a newer version of Decltr. Update Decltr to import it.' };
  if (!Array.isArray(data.sessions)) return notSessions;
  const counts = { skipped: 0 };
  const notes = [];
  const list = data.sessions.slice(0, SESSION_LIMITS.sessions);
  if (data.sessions.length > list.length) notes.push(`Only the first ${list.length} of ${data.sessions.length} sessions in the file are shown.`);
  const future = now + 24 * 60 * 60 * 1000;
  const sessions = [];
  for (const raw of list) {
    const s = sanitizeSession(raw, { fromFile: true, counts });
    if (!s) continue;
    // Times from someone else's file are only trusted when they make sense.
    if (s.createdAt === 0 || s.createdAt > future) s.createdAt = now;
    if (s.updatedAt < s.createdAt || s.updatedAt > future) s.updatedAt = s.createdAt;
    if (s.nameAt > future) s.nameAt = s.createdAt;
    sessions.push(s);
  }
  return finish({
    kind: 'decltr',
    sessions,
    skipped: counts.skipped,
    notes,
    from: { app: clean(data.from?.app, 40), browser: clean(data.from?.browser, 40) },
    exportedAt: Number.isFinite(Date.parse(data.exportedAt)) ? Date.parse(data.exportedAt) : undefined,
  });
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const MD_LINK = /\[([^\]\n]*)\]\(\s*(https?:\/\/[^\s)]+|file:\/\/[^\s)]+)\s*\)/gi;
const ONETAB_LINE = /^(https?:\/\/\S+)\s+\|\s*(.*)$/i;
// Sentence punctuation after an address is not part of it. "%29" is how sessionsToMarkdown writes ")".
const tidyUrl = (u) => u.replace(/[.,;:!?]+$/, '').replace(/%29/g, ')');

function readLinks(text, { name, now }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const linkLines = lines.filter((l) => /https?:\/\//i.test(l));
  if (linkLines.length === 0) return notSessions;
  // OneTab puts one "address | title" per line and a blank line between tab groups it saved separately.
  const oneTab = linkLines.filter((l) => ONETAB_LINE.test(l.trim())).length >= linkLines.length / 2;
  const colors = GROUP_COLORS.filter((c) => c !== 'grey');
  const sessions = [];
  let current = null;
  let group = -1;
  const start = (title) => {
    current = { name: title, nameSource: 'user', createdAt: now, updatedAt: now, tabs: [], groups: [] };
    sessions.push(current);
    group = -1;
  };
  const add = (url, title) => {
    if (!current) start(name);
    current.tabs.push({ url: tidyUrl(url), title: clean(title, SESSION_LIMITS.title) || tidyUrl(url), g: group });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (oneTab && current?.tabs.length) current = null; // the next block is another session
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const title = clean(heading[2], SESSION_LIMITS.name);
      if (heading[1].length <= 2) start(title || name);
      else {
        if (!current) start(name);
        current.groups.push({ title: clean(heading[2], SESSION_LIMITS.groupTitle), color: colors[current.groups.length % colors.length], collapsed: false });
        group = current.groups.length - 1;
      }
      continue;
    }
    const md = [...line.matchAll(MD_LINK)];
    if (md.length) {
      for (const m of md) add(m[2], m[1]);
      continue;
    }
    const tab = ONETAB_LINE.exec(line);
    if (tab) {
      add(tab[1], tab[2]);
      continue;
    }
    const urls = line.match(URL_IN_TEXT) ?? [];
    // The words around a single address are its title: "Lisbon hotels - https://…", or a bookmarks file's <A> text.
    const rest = clean(line.replace(URL_IN_TEXT, ' ').replace(/<[^>]*>/g, ' ').replace(/^[-*•\d.)\s]+/, '').replace(/[\s\-–—:|]+$/, ''), SESSION_LIMITS.title);
    for (const u of urls) add(u, urls.length === 1 && rest ? rest : '');
  }
  // Blocks without a heading get the file's name, numbered when there are several.
  const unnamed = sessions.filter((s) => s.name === name);
  if (unnamed.length > 1) unnamed.forEach((s, k) => (s.name = clean(`${name} ${k + 1}`, SESSION_LIMITS.name)));
  const counts = { skipped: 0 };
  const clean_ = sessions.map((s) => sanitizeSession(s, { fromFile: true, counts })).filter(Boolean);
  return finish({ kind: 'links', sessions: clean_, skipped: counts.skipped, notes: [] });
}

/** Drop sessions that appear twice in the same file, and refuse a file with nothing usable in it. */
function finish(result) {
  const seen = new Set();
  const sessions = [];
  let duplicates = 0;
  for (const s of result.sessions) {
    const key = contentKey(s);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    sessions.push(s);
  }
  if (sessions.length === 0) {
    return result.skipped
      ? { ok: false, code: 'nothing_usable', message: 'Nothing in this file can be opened: it only has browser pages or addresses Decltr does not open from files.' }
      : notSessions;
  }
  return { ok: true, ...result, sessions, duplicates };
}
