// Sharing sessions between browsers: two pretend browsers (mock chrome.* each) talk to the real server code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockChrome } from '../dev/mock-chrome.js';
import { createApp } from '../server/src/app.js';
import { DEFAULT_EXTENSION_ID, loadConfig } from '../server/src/config.js';
import { openSharedStore, SHARE_LIMITS } from '../server/src/shared-store.js';
import {
  addSessions, applyAutoName, buildSession, deleteSession, loadSessions, removeSessions, renameSession, saveSession, updateSessionContent,
} from '../extension/lib/sessions.js';
import {
  configureShare, forgetBrowser, getShare, liveElsewhere, registerShareTriggers, resolvePending, savedIn, syncNow, turnOffSharing, turnOnSharing,
} from '../extension/lib/share.js';
import { getLinks, linkWindow } from '../extension/lib/tracker.js';
import { openTracked } from '../extension/lib/session-ops.js';

const ORIGIN = `chrome-extension://${DEFAULT_EXTENSION_ID}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(dir) {
  const config = loadConfig({ DECLTR_PORT: '47999', DECLTR_DATA_DIR: dir });
  const store = await openSharedStore(join(dir, 'shared'));
  const server = createApp({ config, getApiKey: async () => null, store });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port; // the Host check expects the port it listens on
  const url = `http://127.0.0.1:${config.port}`;
  configureShare({ serverUrl: url, headers: { origin: ORIGIN } });
  return { url, store, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'decltr-share-test-'));
  const server = await startServer(dir);
  return { dir, server, cleanup: async () => { await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

const browser = (name) => ({ name, chrome: createMockChrome({ tabs: [{ id: 1, url: 'https://keep.example/', title: 'Keep', active: true }] }) });
/** Run fn as browser b. Calls are awaited one after another, so switching the global is safe. */
const as = async (b, fn) => {
  globalThis.chrome = b.chrome;
  return fn();
};
const mk = (name, urls, over = {}) => ({
  ...buildSession({ name, nameSource: 'user', tabs: urls.map((u, i) => ({ id: i + 1, url: u, title: `Page ${u}`, groupId: -1 })), groups: new Map(), now: over.now ?? Date.now() }),
  ...over,
});
const list = (b) => as(b, async () => (await loadSessions()).map((s) => s.name).sort());
const sync = (b) => as(b, () => syncNow());
const on = (b) => as(b, () => turnOnSharing({ name: b.name }));

test('turning sharing on merges both sides: nothing is deleted, and the same session is kept once', async () => {
  const { cleanup } = await setup();
  try {
    const chrome = browser('Google Chrome');
    const edge = browser('Microsoft Edge');
    await as(chrome, () => addSessions([mk('Lisbon trip', ['https://a.example/1', 'https://a.example/2']), mk('Recipes', ['https://r.example/'])]));
    await as(edge, () => addSessions([mk('Work', ['https://w.example/']), mk('Lisbon (copy)', ['https://a.example/1', 'https://a.example/2'], { nameSource: 'default' })]));

    assert.deepEqual(await on(chrome), { ok: true, at: (await as(chrome, getShare)).status.at });
    await on(edge);
    await sync(chrome);
    assert.deepEqual(await list(chrome), ['Lisbon trip', 'Recipes', 'Work']);
    assert.deepEqual(await list(edge), ['Lisbon trip', 'Recipes', 'Work'], 'the copy with the same tabs became the shared session, with the typed name');

    const edgeState = await as(edge, getShare);
    assert.deepEqual(edgeState.peers.map((p) => p.name), ['Google Chrome']);
    const work = (await as(chrome, loadSessions)).find((s) => s.name === 'Work');
    assert.equal(await as(chrome, async () => savedIn(await getShare(), work)), 'Microsoft Edge', 'Chrome knows where Work came from');
  } finally {
    await cleanup();
  }
});

test('renames, AI names and tab changes go across, merged by the same rules everywhere', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Google Chrome');
    const b = browser('Microsoft Edge');
    const s = mk('Session 27 Nov', ['https://x.example/'], { nameSource: 'default' });
    await as(a, () => saveSession(s));
    await on(a);
    await on(b);
    // At the same time: Chrome's AI names it, Edge's person names it, and Chrome's live window adds a tab.
    await as(b, () => renameSession(s.id, 'Lisbon'));
    await sleep(5);
    await as(a, () => applyAutoName(s.id, 'Lisbon Trip Planning'));
    await as(a, () => updateSessionContent(s.id, { tabs: [...s.tabs, { url: 'https://y.example/', title: 'Y', favIcon: '', pinned: false, g: -1 }], groups: [] }));
    await sync(a);
    await sync(b);
    await sync(a);
    for (const x of [a, b]) {
      const [got] = await as(x, loadSessions);
      assert.equal(got.name, 'Lisbon', `${x.name}: the typed name wins over the later AI name`);
      assert.equal(got.tabs.length, 2, `${x.name}: the new tab is kept too`);
    }
    // A later typed name wins over an earlier one.
    await as(a, () => renameSession(s.id, 'Lisbon 2027'));
    await sync(a);
    await sync(b);
    assert.deepEqual(await list(b), ['Lisbon 2027']);
  } finally {
    await cleanup();
  }
});

test('a deletion wins, even over a change made at the same time in another browser', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    const s = mk('Doomed', ['https://d.example/']);
    const keep = mk('Kept', ['https://k.example/']);
    await as(a, () => addSessions([s, keep]));
    await on(a);
    await on(b);
    await as(a, () => deleteSession(s.id));
    await as(b, () => renameSession(s.id, 'Renamed meanwhile'));
    await sync(b); // Edge sends its rename first
    await sync(a); // then Chrome its deletion
    await sync(b);
    await sync(a);
    assert.deepEqual(await list(a), ['Kept']);
    assert.deepEqual(await list(b), ['Kept'], 'the rename did not bring it back');
    // Saving the deleted session again (an old copy) does not resurrect it either.
    await as(b, () => saveSession(s));
    await sync(b);
    assert.deepEqual(await list(b), ['Kept']);
  } finally {
    await cleanup();
  }
});

test('while the server is stopped everything keeps working, and changes go across once it is back', async () => {
  const { dir, server, cleanup } = await setup();
  let second;
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    await on(a);
    await on(b);
    await server.close();
    await as(a, () => saveSession(mk('Made offline', ['https://o.example/'])));
    const status = await sync(a);
    assert.equal(status.ok, false);
    assert.equal(status.code, 'offline');
    assert.deepEqual(await list(a), ['Made offline'], 'still here');
    second = await startServer(dir); // same folder, new port
    await sync(a);
    await sync(b);
    assert.deepEqual(await list(b), ['Made offline']);
  } finally {
    await second?.close();
    await cleanup().catch(() => {});
  }
});

test('many deletions at once wait for you; a deliberate bulk removal (undoing an import) does not ask again', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Google Chrome');
    const b = browser('Microsoft Edge');
    const sessions = Array.from({ length: 20 }, (_, i) => mk(`S${String(i).padStart(2, '0')}`, [`https://s.example/${i}`]));
    await as(a, () => addSessions(sessions));
    await on(a);
    await on(b);
    // Chrome deletes 15 one by one (each confirmed there). Edge has not seen any of that yet.
    for (const s of sessions.slice(0, 15)) await as(a, () => deleteSession(s.id));
    await sync(a);
    await sync(b);
    let state = await as(b, getShare);
    assert.equal(state.pending?.kind, 'incoming');
    assert.equal(state.pending.ids.length, 15);
    assert.deepEqual(state.pending.by, ['Google Chrome']);
    assert.equal((await list(b)).length, 20, 'nothing removed yet');

    // "Restore them": they come back everywhere, as new sessions.
    await as(b, () => resolvePending('restore'));
    await sync(a);
    assert.equal((await list(a)).length, 20);
    assert.equal((await as(b, getShare)).pending, null);

    // Importing 30 and undoing it removes 30 at once, but you already chose that: no question elsewhere.
    const imported = Array.from({ length: 30 }, (_, i) => mk(`Imp${i}`, [`https://imp.example/${i}`]));
    const ids = await as(a, () => addSessions(imported));
    await sync(a);
    await sync(b);
    assert.equal((await list(b)).length, 50);
    await as(a, () => removeSessions(ids, { bulk: true }));
    await sync(a);
    await sync(b);
    state = await as(b, getShare);
    assert.equal(state.pending, null);
    assert.equal((await list(b)).length, 20);
  } finally {
    await cleanup();
  }
});

test('sessions that go missing without being deleted are not deleted elsewhere: you can bring them back', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    await as(a, () => addSessions(Array.from({ length: 20 }, (_, i) => mk(`S${i}`, [`https://s.example/${i}`]))));
    await on(a);
    await on(b);
    // Something wipes 15 of Edge's sessions behind Decltr's back.
    await as(b, async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('decltr.session.')).slice(0, 15));
    });
    await sync(b);
    const state = await as(b, getShare);
    assert.equal(state.pending?.kind, 'outgoing');
    assert.equal(state.pending.ids.length, 15);
    await sync(a);
    assert.equal((await list(a)).length, 20, 'nothing was deleted in Chrome');
    // While Edge waits for an answer, Chrome renames one of the missing sessions. Edge does not quietly re-add it.
    const missingId = state.pending.ids[0];
    await as(a, () => renameSession(missingId, 'Renamed in Chrome'));
    await sync(a);
    await sync(b);
    assert.equal((await list(b)).length, 5, 'still waiting for you');
    await as(b, () => resolvePending('restore'));
    assert.equal((await list(b)).length, 20, 'brought back from the server');
    assert.ok((await list(b)).includes('Renamed in Chrome'), 'with the newest name');
    // A few missing sessions (under the threshold) are simply deletions.
    await as(b, async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('decltr.session.')).slice(0, 2));
    });
    await sync(b);
    await sync(a);
    assert.equal((await list(a)).length, 18);
  } finally {
    await cleanup();
  }
});

test('only one browser keeps a session live; opening it live in another moves it there', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Google Chrome');
    const b = browser('Microsoft Edge');
    const s = mk('Live one', ['https://l.example/1', 'https://l.example/2']);
    await as(a, () => saveSession(s));
    await on(a);
    await on(b);
    const infoA = await as(a, () => openTracked(s, { target: 'new', windowId: 1 }));
    assert.equal(infoA.tracking, true);
    await sync(a); // claims it
    await sync(b);
    assert.deepEqual(await as(b, async () => liveElsewhere(await getShare(), s.id)), { id: (await as(a, getShare)).me.id, name: 'Google Chrome' });

    // In Edge it opens without syncing...
    const infoB = await as(b, () => openTracked(s, { target: 'new', windowId: 1 }));
    assert.equal(infoB.tracking, false);
    assert.equal(infoB.liveElsewhere, 'Google Chrome');
    // ...unless you choose "Sync here instead".
    const takeOver = await as(b, () => openTracked(s, { target: 'new', windowId: 1, takeOver: true }));
    assert.equal(takeOver.tracking, true);
    await sleep(5);
    await sync(b);
    await sync(a);
    assert.deepEqual(await as(a, getLinks), {}, 'Chrome stopped following its window; the window stays open');
    assert.ok(a.chrome.__state.windows.has(infoA.windowId));
    assert.equal((await as(a, async () => liveElsewhere(await getShare(), s.id))).name, 'Microsoft Edge');
  } finally {
    await cleanup();
  }
});

test('turning sharing off keeps every session; a browser can be taken off the list', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    await as(a, () => saveSession(mk('Mine', ['https://m.example/'])));
    await on(a);
    await on(b);
    await as(b, () => turnOffSharing());
    assert.deepEqual(await list(b), ['Mine'], 'Edge keeps its copy');
    await sync(a);
    assert.deepEqual((await as(a, getShare)).peers, [], 'Edge left the list');
    await on(b);
    await sync(a);
    assert.equal((await as(a, getShare)).peers.length, 1);
    const edgeId = (await as(b, getShare)).me.id;
    await as(a, () => forgetBrowser(edgeId));
    assert.equal((await as(a, getShare)).peers.length, 0);
    assert.deepEqual(await list(b), ['Mine'], 'nothing was deleted, and there is still only one');
  } finally {
    await cleanup();
  }
});

test('a replaced or restored shared folder is noticed, and the browsers fill it again without losing anything', async () => {
  const { dir, server, cleanup } = await setup();
  let fresh;
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    await as(a, () => saveSession(mk('From Chrome', ['https://c.example/'])));
    await as(b, () => saveSession(mk('From Edge', ['https://e.example/'])));
    await on(a);
    await on(b);
    await server.close();
    await rm(join(dir, 'shared'), { recursive: true, force: true }); // someone deletes the folder
    fresh = await startServer(dir);
    await sync(a);
    await sync(b);
    await sync(a);
    assert.deepEqual(await list(a), ['From Chrome', 'From Edge']);
    assert.deepEqual(await list(b), ['From Chrome', 'From Edge']);
    assert.equal(fresh.store.summary().sessions, 2);
  } finally {
    await fresh?.close();
    await cleanup().catch(() => {});
  }
});

test('background triggers: a change here is sent about a second later, and focus or the alarm brings changes in', async () => {
  const { cleanup } = await setup();
  try {
    const a = browser('Chrome');
    const b = browser('Edge');
    await on(a);
    await on(b);
    await as(a, () => registerShareTriggers({ delay: 20 }));
    await as(a, () => saveSession(mk('Saved in Chrome', ['https://t.example/'])));
    await sleep(150);
    globalThis.chrome = a.chrome;
    await sleep(150);
    await sync(b);
    assert.deepEqual(await list(b), ['Saved in Chrome']);
    assert.ok(await as(a, () => chrome.alarms.get('decltr-share')), 'a periodic alarm is set');
  } finally {
    await cleanup();
  }
});

// ---- the server's store on its own ----------------------------------------------------------

test('store: refuses unsafe IDs and junk, survives a restart, and a deletion beats a leftover file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decltr-store-test-'));
  try {
    const me = 'aaaaaaaa-0000-0000-0000-000000000001';
    let store = await openSharedStore(dir);
    const s = mk('One', ['https://one.example/']);
    const r = await store.sync({ browser: { id: me, name: 'X' }, cursor: 0, changes: [
      { op: 'put', session: s },
      { op: 'put', session: { ...s, id: '../../escape' } },
      { op: 'put', session: { id: 'bbbbbbbb-0000', tabs: [] } },
      { op: 'delete', id: '../x' },
    ] });
    assert.deepEqual(r.results.map((x) => x.status), ['saved', 'rejected', 'rejected', 'rejected']);
    assert.deepEqual(await readdir(join(dir, 'sessions')), [`${s.id}.json`], 'nothing was written outside the sessions folder');
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'sessions', `${s.id}.json`))).mode & 0o777, 0o600, 'only you can read it');
    await assert.rejects(store.sync({ browser: { id: '../evil' }, cursor: 0 }), { code: 'bad_request' });

    // Restart: everything is read back from the files.
    store = await openSharedStore(dir);
    const again = await store.sync({ browser: { id: me, name: 'X' }, cursor: 0, changes: [] });
    assert.equal(again.changes.length, 1);
    assert.equal(again.changes[0].session.name, 'One');

    // A deletion recorded, but the server stopped before removing the file: the deletion still wins.
    await writeFile(join(dir, 'deleted.json'), JSON.stringify({ [s.id]: { rev: again.rev + 1, at: Date.now(), by: me } }));
    await writeFile(join(dir, 'sessions', `${s.id}.json.123.abc.tmp`), 'half a file');
    store = await openSharedStore(dir);
    assert.equal(store.summary().sessions, 0);
    assert.deepEqual(await readdir(join(dir, 'sessions')), [], 'the old file and the leftover temporary file are gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store: answers in pages, keeps a copy each day for 7 days, and has limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'decltr-store-test-'));
  try {
    let clock = Date.UTC(2026, 10, 1);
    const store = await openSharedStore(dir, { now: () => clock });
    const me = 'aaaaaaaa-0000-0000-0000-000000000001';
    const many = Array.from({ length: SHARE_LIMITS.pageItems + 20 }, (_, i) => mk(`S${i}`, [`https://p.example/${i}`]));
    await store.sync({ browser: { id: me, name: 'A' }, cursor: 0, changes: many.map((session) => ({ op: 'put', session })) });
    const other = 'aaaaaaaa-0000-0000-0000-000000000002';
    const page1 = await store.sync({ browser: { id: other, name: 'B' }, cursor: 0, changes: [] });
    assert.equal(page1.more, true);
    assert.equal(page1.changes.length, SHARE_LIMITS.pageItems);
    const page2 = await store.sync({ browser: { id: other, name: 'B' }, cursor: page1.cursor, changes: [] });
    assert.equal(page2.more, false);
    assert.equal(page2.changes.length, 20);
    assert.equal(new Set([...page1.changes, ...page2.changes].map((c) => c.id)).size, many.length, 'every session exactly once');

    for (let d = 0; d < 10; d++) {
      clock += 86_400_000;
      await store.sync({ browser: { id: me, name: 'A' }, cursor: 0, changes: [{ op: 'put', session: mk(`Day ${d}`, [`https://day.example/${d}`]) }] });
    }
    const days = await readdir(join(dir, 'backups'));
    assert.equal(days.length, 7);
    assert.equal(days.sort().at(-1), '2026-11-11');
    const copy = JSON.parse(await readFile(join(dir, 'backups', '2026-11-11', 'state.json'), 'utf8'));
    assert.ok(copy.rev > 0);

    const stale = await store.sync({ browser: { id: me, name: 'A' }, epoch: 'not-this-store', cursor: 0, changes: [] });
    assert.equal(stale.reset, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the sync route checks Origin and size like every other route', async () => {
  const { server, cleanup } = await setup();
  try {
    const call = (headers, body = '{"browser":{"id":"aaaaaaaa-0000"}}') =>
      fetch(`${server.url}/v1/sessions/sync`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await call({})).status, 403);
    assert.equal((await call({ origin: ORIGIN })).status, 200);
    const health = await (await fetch(`${server.url}/v1/health`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' })).json();
    assert.ok(health.features.includes('sessions'));
    assert.equal(typeof health.sharing.sessions, 'number');
    assert.ok(!health.sharing.folder.includes(process.env.HOME ?? '\u0000'), 'the folder is shown without the user name');
    const big = await call({ origin: ORIGIN }, JSON.stringify({ browser: { id: 'aaaaaaaa-0000' }, pad: 'x'.repeat(9 * 1024 * 1024) })).then((r) => r.status).catch(() => 'closed');
    assert.ok(big === 413 || big === 'closed');
  } finally {
    await cleanup();
  }
});
