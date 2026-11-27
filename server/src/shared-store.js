// Sessions shared between the browsers on this computer (Chrome, Edge, Brave and others with Decltr), kept in a
// folder that only this user can read. Each browser keeps its own copy and syncs through here; see
// extension/lib/share.js for the other half.
//
// On disk, in <dataDir>/shared/:
//   sessions/<id>.json   { id, rev, by, savedBy, savedAt, session }
//   deleted.json         { [id]: { rev, at, by } }   sessions deleted in some browser, so no browser brings them back
//   state.json           { epoch, rev, browsers: { [id]: { name, lastSeen } }, live: { [sessionId]: { browser, since, at } } }
//   backups/YYYY-MM-DD/  a copy of the above from the first change of each day; the last 7 are kept
//
// Every change gets the next revision number, and a browser asks for everything after the last revision it saw.
// Sessions are merged with mergeSessions, which gives the same result in any order, so browsers that change the
// same session at the same time still end up with the same thing. A deletion always wins.
// Files are written to a temporary name and then renamed, so a crash never leaves half a file. Nothing about
// what is in the sessions (addresses, titles) is ever logged.

import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fingerprint, mergeSessions, sanitizeSession, SHARE_ID } from '../../extension/lib/session-format.js';
import { clean } from '../../extension/lib/plan.js';

export const SHARE_LIMITS = Object.freeze({
  sessions: 1000,
  totalBytes: 200 * 1024 * 1024,
  tombstones: 20_000,
  pageBytes: 4 * 1024 * 1024, // per answer; a browser asks again for the rest
  pageItems: 300,
  changesPerRequest: 2000,
  liveMs: 15 * 60 * 1000, // a live claim not renewed for this long has gone
  browserDays: 90, // browsers not seen for this long are dropped from the list
  backups: 7,
});

const FILE_NAME = /^[A-Za-z0-9-]{8,64}\.json$/;
const isId = (v) => typeof v === 'string' && SHARE_ID.test(v);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

/** Open (or create) the store in `dir`. Returns an object whose sync() is the whole protocol. */
export async function openSharedStore(dir, { now = () => Date.now(), log = () => {} } = {}) {
  const sessionsDir = join(dir, 'sessions');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  await chmod(sessionsDir, 0o700).catch(() => {});

  const statePath = join(dir, 'state.json');
  const deletedPath = join(dir, 'deleted.json');
  const raw = await readJsonFile(statePath, {});
  const state = {
    epoch: typeof raw.epoch === 'string' ? raw.epoch : randomUUID(),
    rev: Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
    browsers: raw.browsers && typeof raw.browsers === 'object' ? raw.browsers : {},
    live: raw.live && typeof raw.live === 'object' ? raw.live : {},
  };
  const deleted = {};
  for (const [id, t] of Object.entries(await readJsonFile(deletedPath, {}))) {
    if (isId(id) && Number.isInteger(t?.rev)) deleted[id] = { rev: t.rev, at: Number(t.at) || 0, by: isId(t.by) ? t.by : undefined, ...(t.bulk ? { bulk: true } : {}) };
  }

  // The index: what is in each file, without keeping the sessions themselves in memory.
  const index = new Map(); // id -> { rev, size, by }
  let skipped = 0;
  for (const name of await readdir(sessionsDir)) {
    const path = join(sessionsDir, name);
    if (name.endsWith('.tmp')) {
      await rm(path, { force: true }); // left over from a crash in the middle of a write
      continue;
    }
    if (!FILE_NAME.test(name)) continue;
    const id = name.slice(0, -5);
    const file = await readJsonFile(path, null);
    if (deleted[id]) {
      await rm(path, { force: true }); // deleted after this file was written: the deletion wins
      continue;
    }
    if (!file || file.id !== id || !Number.isInteger(file.rev) || !sanitizeSession(file.session)) {
      skipped++; // unreadable: left where it is, for a person to look at
      continue;
    }
    index.set(id, { rev: file.rev, size: (await stat(path)).size, by: isId(file.by) ? file.by : undefined });
  }
  if (skipped) log(`shared sessions: ${skipped} unreadable file(s) left alone in ${sessionsDir}`);
  for (const e of index.values()) state.rev = Math.max(state.rev, e.rev);
  for (const t of Object.values(deleted)) state.rev = Math.max(state.rev, t.rev);

  let lastStateWrite = 0;
  let backedUpDay = null;
  const totalBytes = () => [...index.values()].reduce((n, e) => n + e.size, 0);
  const saveState = () => writeAtomic(statePath, JSON.stringify(state));
  const saveDeleted = () => writeAtomic(deletedPath, JSON.stringify(deleted));
  const fileOf = (id) => join(sessionsDir, `${id}.json`);
  const readSession = async (id) => (await readJsonFile(fileOf(id), null))?.session ?? null;

  /** Before the first change of a day, copy everything into backups/<day>, and keep only the newest few days. */
  async function backup() {
    const today = day(now());
    if (backedUpDay === today) return;
    backedUpDay = today;
    const target = join(dir, 'backups', today);
    if (await stat(target).catch(() => null)) return;
    try {
      await mkdir(join(target, 'sessions'), { recursive: true, mode: 0o700 });
      for (const id of index.keys()) await copyFile(fileOf(id), join(target, 'sessions', `${id}.json`)).catch(() => {});
      for (const name of ['state.json', 'deleted.json']) await copyFile(join(dir, name), join(target, name)).catch(() => {});
      const days = (await readdir(join(dir, 'backups'))).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).sort();
      for (const old of days.slice(0, Math.max(0, days.length - SHARE_LIMITS.backups))) await rm(join(dir, 'backups', old), { recursive: true, force: true });
    } catch (err) {
      log(`shared sessions: daily copy failed (${err.code ?? err.name})`);
    }
  }

  // One request at a time, so a sync always sees and leaves the store in one piece.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function put(session, me, assigned) {
    const s = sanitizeSession(session);
    if (!s || !isId(s.id)) return { id: isId(session?.id) ? session.id : null, status: 'rejected', code: 'bad_session', message: 'A session could not be read.' };
    const id = s.id;
    if (deleted[id]) return { id, status: 'deleted', rev: deleted[id].rev, by: deleted[id].by };
    const entry = index.get(id);
    const current = entry ? await readSession(id) : null;
    if (!entry && index.size >= SHARE_LIMITS.sessions) {
      return { id, status: 'rejected', code: 'full', message: `The shared sessions are full (${SHARE_LIMITS.sessions} sessions). Delete some to share more.` };
    }
    const merged = current ? mergeSessions(current, s) : { ...s, by: s.by ?? me };
    const sameAsSent = fingerprint(merged) === fingerprint(s);
    if (current && fingerprint(merged) === fingerprint(current) && merged.by === current.by) {
      return sameAsSent ? { id, status: 'saved', rev: entry.rev } : { id, status: 'merged', rev: entry.rev, session: merged };
    }
    const rev = state.rev + 1;
    const text = JSON.stringify({ id, rev, by: merged.by, savedBy: me, savedAt: now(), session: merged });
    const size = Buffer.byteLength(text);
    if (totalBytes() - (entry?.size ?? 0) + size > SHARE_LIMITS.totalBytes) {
      return { id, status: 'rejected', code: 'full', message: 'The shared sessions take up too much space (200 MB). Delete some to share more.' };
    }
    await backup();
    await writeAtomic(fileOf(id), text);
    state.rev = rev;
    index.set(id, { rev, size, by: merged.by });
    assigned.add(rev);
    return sameAsSent ? { id, status: 'saved', rev } : { id, status: 'merged', rev, session: merged };
  }

  async function remove(id, me, assigned, bulk = false) {
    if (!isId(id)) return { id: null, status: 'rejected', code: 'bad_id', message: 'A session ID could not be read.' };
    if (deleted[id]) return { id, status: 'deleted', rev: deleted[id].rev, by: deleted[id].by };
    await backup();
    const rev = state.rev + 1;
    deleted[id] = { rev, at: now(), by: me, ...(bulk ? { bulk: true } : {}) };
    // Forget the oldest deletions once there are very many. Only a browser that has not synced in a very long time could bring one of those back.
    const ids = Object.keys(deleted);
    if (ids.length > SHARE_LIMITS.tombstones) {
      ids.sort((a, b) => deleted[a].rev - deleted[b].rev).slice(0, ids.length - SHARE_LIMITS.tombstones).forEach((old) => delete deleted[old]);
    }
    await saveDeleted(); // first the record, then the file: if the server stops in between, the deletion still wins
    await rm(fileOf(id), { force: true });
    state.rev = rev;
    index.delete(id);
    delete state.live[id];
    assigned.add(rev);
    return { id, status: 'deleted', rev, by: me, ...(bulk ? { bulk: true } : {}) };
  }

  /**
   * The whole protocol, one request:
   *   { browser: { id, name }, epoch, cursor, changes: [{ op: 'put', session } | { op: 'delete', id }],
   *     want: [ids], live: { claim: [{ id, at }], hold: [ids] }, forget?: browserId, leave?: true }
   * Answers { ok, epoch, rev, cursor, more, results, changes, live, browsers, count } or { ok, reset } when the
   * browser's position does not belong to this store (the folder was replaced or restored).
   */
  function sync(req) {
    return exclusive(async () => {
      const t = now();
      const me = req?.browser?.id;
      if (!isId(me)) throw Object.assign(new Error('The browser ID is missing.'), { status: 400, code: 'bad_request' });
      const name = clean(req.browser.name, 40) || 'Browser';
      let stateChanged = false;

      if (req.leave) {
        delete state.browsers[me];
        for (const [sid, c] of Object.entries(state.live)) if (c.browser === me) delete state.live[sid];
        await saveState();
        return { ok: true, left: true };
      }
      if (state.browsers[me]?.name !== name) stateChanged = true;
      state.browsers[me] = { name, lastSeen: t };
      if (isId(req.forget) && req.forget !== me && state.browsers[req.forget]) {
        delete state.browsers[req.forget];
        for (const [sid, c] of Object.entries(state.live)) if (c.browser === req.forget) delete state.live[sid];
        stateChanged = true;
      }
      for (const [id, b] of Object.entries(state.browsers)) {
        if (t - (b.lastSeen ?? 0) > SHARE_LIMITS.browserDays * 86_400_000) {
          delete state.browsers[id];
          stateChanged = true;
        }
      }

      const cursor = Number.isInteger(req.cursor) && req.cursor >= 0 ? req.cursor : 0;
      if ((req.epoch && req.epoch !== state.epoch) || cursor > state.rev) {
        if (stateChanged) await saveState();
        return { ok: true, reset: true, epoch: state.epoch, rev: state.rev };
      }

      // 1. This browser's changes.
      const changes = Array.isArray(req.changes) ? req.changes.slice(0, SHARE_LIMITS.changesPerRequest) : [];
      const results = [];
      const assigned = new Set();
      const revBefore = state.rev;
      for (const c of changes) {
        if (c?.op === 'put') results.push(await put(c.session, me, assigned));
        else if (c?.op === 'delete') results.push(await remove(c.id, me, assigned, c.bulk === true));
      }

      // 2. Live sessions: which browser keeps which session up to date. The newest claim wins.
      for (const [sid, c] of Object.entries(state.live)) {
        if (t - (c.at ?? 0) > SHARE_LIMITS.liveMs || !index.has(sid)) {
          delete state.live[sid];
          stateChanged = true;
        }
      }
      const claims = Array.isArray(req.live?.claim) ? req.live.claim.slice(0, 1000) : [];
      const holds = new Set(Array.isArray(req.live?.hold) ? req.live.hold.slice(0, 1000).filter(isId) : []);
      const mine = new Set();
      for (const c of claims) {
        if (!isId(c?.id) || !index.has(c.id)) continue;
        const since = Number.isFinite(c.at) ? Math.min(c.at, t) : t;
        const cur = state.live[c.id];
        if (!cur || cur.browser === me || since >= (cur.since ?? 0)) {
          if (cur?.browser !== me) stateChanged = true;
          state.live[c.id] = { browser: me, since, at: t };
        }
        mine.add(c.id);
      }
      for (const sid of holds) {
        if (state.live[sid]?.browser === me) state.live[sid].at = t;
        mine.add(sid);
      }
      for (const [sid, c] of Object.entries(state.live)) {
        if (c.browser === me && !mine.has(sid)) {
          delete state.live[sid];
          stateChanged = true;
        }
      }

      // 3. Everything that changed since the browser's last sync, oldest first, a page at a time.
      const due = [];
      for (const [id, e] of index) if (e.rev > cursor && !assigned.has(e.rev)) due.push({ id, rev: e.rev });
      for (const [id, d] of Object.entries(deleted)) if (d.rev > cursor && !assigned.has(d.rev)) due.push({ id, rev: d.rev, deleted: true });
      due.sort((a, b) => a.rev - b.rev);
      const out = [];
      let bytes = 0;
      let last = cursor;
      let more = false;
      for (const item of due) {
        const size = item.deleted ? 80 : index.get(item.id).size;
        if (out.length >= SHARE_LIMITS.pageItems || (out.length && bytes + size > SHARE_LIMITS.pageBytes)) {
          more = true;
          break;
        }
        if (item.deleted) out.push({ id: item.id, rev: item.rev, deleted: true, by: deleted[item.id].by, ...(deleted[item.id].bulk ? { bulk: true } : {}) });
        else {
          const session = await readSession(item.id);
          if (session) out.push({ id: item.id, rev: item.rev, session });
        }
        bytes += size;
        last = item.rev;
      }
      // Sessions asked for by ID ("bring them back"), whatever the position.
      const sent = new Set(out.map((o) => o.id));
      for (const id of (Array.isArray(req.want) ? req.want.slice(0, 2000) : []).filter(isId)) {
        if (sent.has(id)) continue;
        if (deleted[id]) out.push({ id, rev: deleted[id].rev, deleted: true, by: deleted[id].by });
        else if (index.has(id)) out.push({ id, rev: index.get(id).rev, session: await readSession(id) });
      }

      if (stateChanged || state.rev !== revBefore || t - lastStateWrite > 60_000) {
        lastStateWrite = t;
        await saveState();
      }
      return {
        ok: true,
        epoch: state.epoch,
        rev: state.rev,
        cursor: more ? last : state.rev,
        more,
        results,
        changes: out,
        live: Object.fromEntries(Object.entries(state.live).map(([sid, c]) => [sid, { browser: c.browser, since: c.since }])),
        browsers: Object.entries(state.browsers).map(([id, b]) => ({ id, name: b.name, lastSeen: b.lastSeen })),
        count: index.size,
      };
    });
  }

  return {
    dir,
    sync,
    summary: () => ({ sessions: index.size, browsers: Object.keys(state.browsers).length, bytes: totalBytes() }),
    flush: () => exclusive(saveState),
  };
}
