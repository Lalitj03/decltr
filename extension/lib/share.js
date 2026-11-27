// Sharing sessions between the browsers on this computer (Chrome, Edge, Brave and others with Decltr),
// through the optional Decltr server. The server half is server/src/shared-store.js.
//
// Each browser keeps its own copy of every session, exactly as without sharing, and the server is where they
// meet. A sync sends what changed here since the last one and gets back what changed elsewhere. When the
// server is not running nothing breaks: changes simply go across once it is back.
//
// Rules, the same as for one browser:
//  - A deletion wins. A session deleted in one browser is never brought back by another.
//  - A name you typed beats an AI name, which beats the date name; otherwise the later change wins. The name
//    and the tabs are merged separately, so renaming in one browser and changing tabs in another keeps both.
//  - Only one browser at a time keeps a session live (follows its window). The newest claim wins.
//  - When sharing starts, nothing is deleted, and sessions that both sides already have are kept once.
//  - A sync that would delete many sessions at once (more than 10, and more than a third) waits for you.
//
// Everything is stored under SHARE_KEY in this browser's extension storage.

import { SERVER_URL } from './api.js';
import { detectBrowserName } from './browser.js';
import { contentKey, fingerprint, mergeSessions, sanitizeSession, SHARE_ID } from './session-format.js';
import { DELETED_KEY, SESSION_PREFIX, sessionKey, withLock, withSessionsLock } from './sessions.js';
import { getLinks, linkWindow, unlinkWindow } from './tracker.js';

export const SHARE_KEY = 'decltr.share';
const SHARE_LOCK = 'decltr-share';
export const SHARE_ALARM = 'decltr-share';
export const LIVE_MS = 15 * 60 * 1000;
const CHUNK_BYTES = 6 * 1024 * 1024; // the server takes up to 8 MB per request
const MAX_ROUNDS = 100;

/** More than 10 sessions, and more than a third of them, removed in one go: stop and ask. */
export const isMassDelete = (n, total) => n > 10 && n > total / 3;

const EMPTY = Object.freeze({
  on: false, me: null, joined: false, epoch: null, cursor: 0, known: {}, held: [], live: {}, peers: [],
  status: null, pending: null, want: [], force: [], rejected: {}, forget: null, count: 0,
});

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const me = r.me && SHARE_ID.test(r.me.id ?? '') ? { id: r.me.id, name: String(r.me.name ?? '').slice(0, 40) || detectBrowserName(), named: Boolean(r.me.named) } : null;
  return {
    ...EMPTY,
    ...r,
    on: Boolean(r.on) && Boolean(me),
    me,
    known: r.known && typeof r.known === 'object' ? r.known : {},
    held: Array.isArray(r.held) ? r.held : [],
    live: r.live && typeof r.live === 'object' ? r.live : {},
    peers: Array.isArray(r.peers) ? r.peers : [],
    want: Array.isArray(r.want) ? r.want : [],
    force: Array.isArray(r.force) ? r.force : [],
    rejected: r.rejected && typeof r.rejected === 'object' ? r.rejected : {},
  };
}

export const getShare = async () => normalize((await chrome.storage.local.get(SHARE_KEY))[SHARE_KEY]);
const putShare = (state) => chrome.storage.local.set({ [SHARE_KEY]: state });

/** The browser that keeps this session live, if it is another one and its claim is current. */
export function liveElsewhere(state, sessionId, now = Date.now()) {
  if (!state?.on || !state.me) return null;
  const c = state.live?.[sessionId];
  if (!c || c.browser === state.me.id) return null;
  const peer = state.peers.find((p) => p.id === c.browser);
  if (peer && now - (peer.lastSeen ?? 0) > LIVE_MS) return null; // that browser has not been heard from for a while
  return { id: c.browser, name: peer?.name ?? 'another browser' };
}

/** The browser a session was saved in, when that is not this one. */
export function savedIn(state, session) {
  if (!state?.on || !session?.by || session.by === state.me?.id) return null;
  return state.peers.find((p) => p.id === session.by)?.name ?? null;
}

// ---- turning sharing on and off -------------------------------------------------------------

/** Turn sharing on. The first sync merges this browser's sessions with the shared ones; nothing is deleted. */
export async function turnOnSharing({ name, ...options } = {}) {
  await withLock(SHARE_LOCK, async () => {
    const state = await getShare();
    const me = state.me ?? { id: crypto.randomUUID(), name: name ?? detectBrowserName(), named: Boolean(name) };
    await putShare({ ...EMPTY, on: true, me });
    // Deletions made while sharing was off say nothing about what to do with the shared sessions.
    await chrome.storage.local.remove(DELETED_KEY);
  });
  return syncNow({ ...options, reason: 'join' });
}

/** Turn sharing off. Every session stays here; this browser is taken off the list of sharing browsers. */
export async function turnOffSharing(options = {}) {
  await withLock(SHARE_LOCK, async () => {
    const state = await getShare();
    if (state.me) await post({ ...defaults, ...options }, { browser: { id: state.me.id, name: state.me.name }, leave: true }).catch(() => {});
    await putShare({ ...EMPTY, me: state.me });
  });
}

/** Change what this browser is called in the other browsers. */
export async function renameThisBrowser(name, options = {}) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) return;
  await withLock(SHARE_LOCK, async () => {
    const state = await getShare();
    if (state.me) await putShare({ ...state, me: { ...state.me, name: clean, named: true } });
  });
  return syncNow({ ...options, reason: 'rename' });
}

/** Take a browser that no longer shares (an old profile, say) off the list. It comes back if it syncs again. */
export async function forgetBrowser(id, options = {}) {
  await withLock(SHARE_LOCK, async () => {
    const state = await getShare();
    await putShare({ ...state, forget: id, peers: state.peers.filter((p) => p.id !== id) });
  });
  return syncNow({ ...options, reason: 'forget' });
}

/**
 * Answer a paused mass deletion.
 *  incoming (another browser removed many): 'remove' removes them here too; 'restore' keeps them and shares them again.
 *  outgoing (many went missing here): 'remove' removes them everywhere; 'restore' brings them back from the server.
 */
export async function resolvePending(choice, options = {}) {
  await withLock(SHARE_LOCK, async () => {
    const state = await getShare();
    const pending = state.pending;
    if (!pending) return;
    if (pending.kind === 'incoming') {
      await withSessionsLock(async () => {
        if (choice === 'remove') {
          await chrome.storage.local.remove(pending.ids.map(sessionKey));
        } else {
          // Shared again under new IDs, as new sessions, because the old IDs are deleted for good.
          for (const id of pending.ids) await rekey(id, crypto.randomUUID());
        }
      });
      for (const id of pending.ids) delete state.known[id];
    } else if (choice === 'remove') {
      state.force = [...new Set([...state.force, ...pending.ids])];
    } else {
      for (const id of pending.ids) delete state.known[id];
      state.want = [...new Set([...state.want, ...pending.ids])];
    }
    await putShare({ ...state, pending: null });
  });
  return syncNow({ ...options, reason: 'resolve' });
}

// ---- syncing ---------------------------------------------------------------------------------

let running = null;
const queued = new Set();
// Where the server is. Tests point this at a server of their own; the extension never changes it.
let defaults = { fetchImpl: (...args) => fetch(...args), serverUrl: SERVER_URL, headers: {} };
export function configureShare(options) {
  defaults = { ...defaults, ...options };
}

/**
 * Sync now. Runs one sync at a time in this browser (the panel and the background share a lock).
 * With `ifIdle`, a sync that is already running in this page counts and none is started.
 * Returns the status: { ok, at, code?, message? } or { skipped }.
 */
export function syncNow(options = {}) {
  if (options.ifIdle && running) return running;
  const run = withLock(SHARE_LOCK, () => runSync({ ...defaults, ...options })).finally(() => {
    if (running === run) running = null;
  });
  running = run;
  return run;
}

/** Sync soon, for example right after opening a session live. Several requests close together make one sync. */
export function requestSync(reason = 'soon', ms = 400) {
  if (queued.has(reason)) return;
  queued.add(reason);
  const api = globalThis.chrome;
  setTimeout(() => {
    queued.delete(reason);
    if (globalThis.chrome !== api) return; // only in tests, which switch between pretend browsers
    getShare().then((s) => s.on && syncNow({ reason }).catch(() => {}));
  }, ms);
}

async function post({ fetchImpl, serverUrl, headers }, body) {
  let res;
  try {
    res = await fetchImpl(`${serverUrl}/v1/sessions/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw Object.assign(new Error('The Decltr server is not running.'), { code: 'offline' });
  }
  const json = await res.json().catch(() => null);
  if (res.status === 404) throw Object.assign(new Error('The Decltr server is too old to share sessions. Restart it to update it.'), { code: 'outdated' });
  if (!res.ok || !json?.ok) throw Object.assign(new Error(json?.error?.message ?? `The Decltr server answered ${res.status}.`), { code: json?.error?.code ?? 'error' });
  return json;
}

/** Every session in this browser, checked. Must run inside withSessionsLock. */
async function readLocal() {
  const all = await chrome.storage.local.get(null);
  const out = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SESSION_PREFIX)) continue;
    const s = sanitizeSession(value);
    if (s) out.set(s.id, s);
  }
  return out;
}

/** Store a session under a new ID, and move any window that follows it along. Must run inside withSessionsLock. */
async function rekey(oldId, newId, session) {
  const s = session ?? sanitizeSession((await chrome.storage.local.get(sessionKey(oldId)))[sessionKey(oldId)]);
  if (!s) return;
  const { by, ...rest } = s; // a copy made here was not saved by the other browser
  await chrome.storage.local.set({ [sessionKey(newId)]: { ...rest, id: newId } });
  await chrome.storage.local.remove(sessionKey(oldId));
  for (const [w, sid] of Object.entries(await getLinks())) if (sid === oldId) await linkWindow(Number(w), newId);
}

async function runSync({ fetchImpl, serverUrl, headers, now = Date.now, reason = 'sync' }) {
  let state = await getShare();
  if (!state.on || !state.me) return { skipped: 'off' };
  const before = JSON.stringify({ ...state, status: null });
  const prevStatus = state.status;
  const net = { fetchImpl, serverUrl, headers };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!state.joined) state = await join(state, net, now);
      const result = await exchange(state, net, now, reason);
      if (result.reset) {
        // The shared folder was replaced or restored: start over as if sharing had just been turned on.
        state = { ...state, joined: false, cursor: 0, known: {}, held: [], epoch: result.epoch, rejected: {} };
        continue;
      }
      state = result.state;
      if (result.skipped) return { skipped: 'nothing to send' };
      break;
    }
    state.status = { ok: true, at: now() };
  } catch (err) {
    state.status = { ok: false, at: now(), code: err?.code ?? 'error', message: err?.message ?? 'Sharing did not work.' };
  }
  // Turning sharing off takes the same lock, so it cannot happen during a sync. Checked anyway, so a sync
  // can never turn it back on.
  const latest = await getShare();
  if (!latest.on || latest.me?.id !== state.me.id) return { skipped: 'turned off' };
  // The panel syncs every few seconds. When nothing changed, the state is not written again each time.
  const unchanged = JSON.stringify({ ...state, status: null }) === before
    && prevStatus?.ok === state.status.ok && prevStatus?.code === state.status.code && state.status.at - (prevStatus?.at ?? 0) < 60_000;
  if (!unchanged) await putShare(state);
  return state.status;
}

/**
 * The first sync after sharing is turned on: get every shared session, keep what both sides have once, and
 * delete nothing. Sessions this browser has under an ID that was deleted elsewhere get a new ID instead.
 */
async function join(state, net, now) {
  state = { ...state, cursor: 0, known: {}, held: [], rejected: {}, want: [], force: [], pending: null };
  const consumed = new Set();
  let byContent = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await post(net, { browser: brief(state.me), cursor: state.cursor, changes: [], live: { claim: [], hold: [] } });
    if (res.reset) {
      state = { ...state, cursor: 0, epoch: res.epoch };
      continue;
    }
    state.epoch = res.epoch;
    await withSessionsLock(async () => {
      const local = await readLocal();
      if (!byContent) {
        byContent = new Map();
        for (const s of local.values()) if (!byContent.has(contentKey(s))) byContent.set(contentKey(s), s.id);
      }
      const writes = {};
      for (const c of res.changes ?? []) {
        if (c.deleted) {
          if (local.has(c.id)) await rekey(c.id, crypto.randomUUID(), local.get(c.id));
          continue;
        }
        const remote = sanitizeSession(c.session);
        if (!remote || remote.id !== c.id) continue;
        const here = local.get(c.id);
        if (here) {
          writes[sessionKey(c.id)] = mergeSessions(here, remote);
        } else {
          const twinId = byContent.get(contentKey(remote));
          const twin = twinId && !consumed.has(twinId) && twinId !== c.id ? local.get(twinId) : null;
          if (twin) {
            // The same pages in the same groups: one session, under the shared ID, with the better name.
            consumed.add(twinId);
            writes[sessionKey(c.id)] = mergeSessions({ ...twin, id: c.id, by: undefined }, remote);
            await chrome.storage.local.remove(sessionKey(twinId));
            for (const [w, sid] of Object.entries(await getLinks())) if (sid === twinId) await linkWindow(Number(w), c.id);
          } else {
            writes[sessionKey(c.id)] = remote;
          }
        }
        state.known[c.id] = { rev: c.rev, fp: fingerprint(remote) };
      }
      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    });
    state.cursor = res.cursor;
    absorb(state, res);
    if (!res.more) break;
  }
  return { ...state, joined: true };
}

const brief = (me) => ({ id: me.id, name: me.name });

/** Peers, live claims and the store size from an answer. */
function absorb(state, res) {
  state.peers = (res.browsers ?? []).filter((b) => b.id !== state.me.id);
  state.live = res.live ?? {};
  state.held = Object.entries(state.live).filter(([, c]) => c.browser === state.me.id).map(([id]) => id);
  if (Number.isInteger(res.count)) state.count = res.count;
  // Two profiles of the same browser would otherwise both be called "Google Chrome".
  if (!state.me.named && state.peers.some((p) => p.name === state.me.name)) {
    let k = 2;
    const taken = new Set(state.peers.map((p) => p.name));
    while (taken.has(`${state.me.name} (${k})`)) k++;
    state.me = { ...state.me, name: `${state.me.name} (${k})` };
  }
}

/** Send what changed here, then take in what changed elsewhere, a page at a time. */
async function exchange(state, net, now, reason) {
  state = { ...state, known: { ...state.known } };
  const { local, journal } = await withSessionsLock(async () => {
    const all = await readLocal();
    // Sessions saved by very old versions may have IDs that cannot travel. Give them new ones.
    for (const [id, s] of [...all]) {
      if (SHARE_ID.test(id)) continue;
      const fresh = crypto.randomUUID();
      await rekey(id, fresh, s);
      all.delete(id);
      all.set(fresh, { ...s, id: fresh });
    }
    return { local: all, journal: (await chrome.storage.local.get(DELETED_KEY))[DELETED_KEY] ?? [] };
  });

  // 1. What changed here.
  const puts = [];
  for (const s of local.values()) {
    const fp = fingerprint(s);
    if (state.known[s.id]?.fp !== fp && state.rejected[s.id] !== fp) puts.push({ op: 'put', session: s, fp });
  }
  const missing = Object.keys(state.known).filter((id) => !local.has(id));
  const onPurpose = new Set([...journal.map((d) => d.id), ...state.force]);
  // Removals you already confirmed as a whole are marked, so the other browsers do not ask about them again.
  const bulk = new Set([...journal.filter((d) => d.bulk).map((d) => d.id), ...state.force]);
  const deletes = missing.filter((id) => onPurpose.has(id));
  const unexplained = missing.filter((id) => !onPurpose.has(id));
  if (unexplained.length) {
    if (isMassDelete(unexplained.length, local.size + unexplained.length)) {
      if (state.pending?.kind !== 'outgoing') state.pending = { kind: 'outgoing', ids: unexplained, at: now() };
    } else {
      deletes.push(...unexplained);
    }
  }
  const links = await getLinks();
  const linked = [...new Set(Object.values(links))].filter((id) => SHARE_ID.test(id) && local.has(id));
  const held = new Set(state.held);
  const live = { claim: linked.filter((id) => !held.has(id)).map((id) => ({ id, at: now() })), hold: linked.filter((id) => held.has(id)) };

  // A sync started by a change here has nothing to do if nothing here changed.
  if (reason === 'change' && !puts.length && !deletes.length && !live.claim.length) return { state, skipped: true };

  // 2. Send it, in pieces small enough for the server, and keep asking while there is more.
  const chunks = [];
  let chunk = deletes.map((id) => ({ op: 'delete', id, ...(bulk.has(id) ? { bulk: true } : {}) }));
  let size = 0;
  for (const p of puts) {
    const bytes = JSON.stringify(p.session).length;
    if (chunk.length && size + bytes > CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(p);
    size += bytes;
  }
  if (chunk.length) chunks.push(chunk);

  const incoming = new Map(); // session ID -> { by: the browser that deleted it, bulk }
  let first = true;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const changes = chunks.shift() ?? [];
    const res = await post(net, {
      browser: brief(state.me),
      epoch: state.epoch,
      cursor: state.cursor,
      changes: changes.map((c) => (c.op === 'put' ? { op: 'put', session: c.session } : c)),
      live,
      want: first ? state.want : [],
      ...(first && state.forget ? { forget: state.forget } : {}),
    });
    if (res.reset) return { reset: true, epoch: res.epoch };
    state.epoch = res.epoch;
    if (first) {
      state.want = [];
      state.forget = null;
    }
    first = false;
    await apply(state, res, changes, local, incoming);
    state.cursor = res.cursor;
    absorb(state, res);
    if (!res.more && chunks.length === 0) break;
  }

  // 3. Deletions from elsewhere. Many at once wait for you; a few happen now.
  const waiting = new Set(state.pending?.kind === 'incoming' ? state.pending.ids : []);
  const fresh = [...incoming.keys()].filter((id) => !waiting.has(id));
  const confirmed = fresh.filter((id) => incoming.get(id).bulk);
  let toRemove = fresh.filter((id) => !incoming.get(id).bulk);
  if (toRemove.length && isMassDelete(toRemove.length, local.size)) {
    const names = [...new Set(toRemove.map((id) => state.peers.find((p) => p.id === incoming.get(id).by)?.name).filter(Boolean))];
    state.pending = { kind: 'incoming', ids: toRemove, at: now(), by: names };
    toRemove = [];
  }
  toRemove.push(...confirmed);
  if (toRemove.length) {
    await withSessionsLock(() => chrome.storage.local.remove(toRemove.map(sessionKey)));
    for (const id of toRemove) delete state.known[id];
  }

  // Deletions that went across, and sessions given back, are done.
  const sentDeletes = new Set(deletes);
  state.force = state.force.filter((id) => !sentDeletes.has(id));
  if (journal.length) {
    await withSessionsLock(async () => {
      const current = (await chrome.storage.local.get(DELETED_KEY))[DELETED_KEY] ?? [];
      const left = current.filter((d) => state.known[d.id] && !sentDeletes.has(d.id));
      if (left.length !== current.length) await chrome.storage.local.set({ [DELETED_KEY]: left });
    });
  }

  // A window that follows a session another browser has since taken over stops following it. It stays open.
  for (const [w, sid] of Object.entries(links)) {
    const c = state.live[sid];
    if (c && c.browser !== state.me.id) await unlinkWindow(Number(w));
  }
  return { state };
}

/** Take in one answer: the results of what was sent, and what changed elsewhere. */
async function apply(state, res, sent, local, incoming) {
  const sentFp = new Map(sent.filter((c) => c.op === 'put').map((c) => [c.session.id, c.fp]));
  await withSessionsLock(async () => {
    const current = await readLocal();
    const writes = {};
    for (const r of res.results ?? []) {
      if (!r?.id) continue;
      if (r.status === 'saved') {
        state.known[r.id] = { rev: r.rev, fp: sentFp.get(r.id) ?? state.known[r.id]?.fp };
      } else if (r.status === 'merged') {
        const remote = sanitizeSession(r.session);
        const here = current.get(r.id);
        if (remote && here) {
          const merged = mergeSessions(here, remote);
          if (fingerprint(merged) !== fingerprint(here) || merged.by !== here.by) writes[sessionKey(r.id)] = merged;
        }
        if (remote) state.known[r.id] = { rev: r.rev, fp: fingerprint(remote) };
      } else if (r.status === 'deleted') {
        if (current.has(r.id)) incoming.set(r.id, { by: r.by, bulk: Boolean(r.bulk) });
        else delete state.known[r.id];
      } else if (r.status === 'rejected') {
        if (sentFp.has(r.id)) state.rejected[r.id] = sentFp.get(r.id);
        state.problem = r.message;
      }
    }
    for (const c of res.changes ?? []) {
      if (!c?.id) continue;
      if (c.deleted) {
        if (current.has(c.id)) incoming.set(c.id, { by: c.by, bulk: Boolean(c.bulk) });
        else delete state.known[c.id];
        continue;
      }
      const remote = sanitizeSession(c.session);
      if (!remote || remote.id !== c.id) continue;
      const here = current.get(c.id);
      if (!here) {
        // Known here but gone: it was deleted here, and that deletion is on its way (or waiting for you).
        if (state.known[c.id]) continue;
        writes[sessionKey(c.id)] = remote;
      } else {
        const merged = mergeSessions(here, remote);
        if (fingerprint(merged) !== fingerprint(here) || merged.by !== here.by) writes[sessionKey(c.id)] = merged;
      }
      state.known[c.id] = { rev: c.rev, fp: fingerprint(remote) };
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    for (const s of Object.values(writes)) local.set(s.id, s);
  });
}

// ---- when to sync ----------------------------------------------------------------------------

/**
 * Background triggers: a second after a session changes here, when you switch to this browser, and every
 * few minutes. Registered by background.js. The panel also syncs while the Sessions tab is open (share-view.js).
 */
export function registerShareTriggers({ api = chrome, delay = 1000, periodMinutes = 3 } = {}) {
  let timer = null;
  let on = null;
  const isOn = async () => (on ??= (await getShare()).on);
  const run = async (reason) => {
    if (await isOn()) await syncNow({ reason, ifIdle: reason !== 'change' }).catch(() => {});
  };
  const soon = (reason, ms = delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => run(reason), ms);
  };
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (SHARE_KEY in changes) on = Boolean(changes[SHARE_KEY].newValue?.on);
    if (Object.keys(changes).some((k) => k.startsWith(SESSION_PREFIX))) soon('change');
  });
  api.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId !== (api.windows.WINDOW_ID_NONE ?? -1)) soon('focus', 300);
  });
  if (api.alarms) {
    api.alarms.onAlarm.addListener((alarm) => alarm.name === SHARE_ALARM && run('alarm'));
    Promise.resolve(api.alarms.get(SHARE_ALARM)).then((a) => a || api.alarms.create(SHARE_ALARM, { periodInMinutes: periodMinutes })).catch(() => {});
  }
  return { flush: () => run('flush') };
}
