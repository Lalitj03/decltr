// Real Chrome and real Edge sharing sessions through the real server code, end to end.
// The server runs here, on a spare port, with a temporary folder, so a Decltr server you run yourself
// (port 47821) is not touched. Both browsers use throwaway profiles and a copy of the extension that
// talks to the spare port.
//   node dev/share-lab/two-browsers.mjs
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, EDGE, launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';
import { createApp } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { openSharedStore } from '../../server/src/shared-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 47911;
const work = mkdtempSync(join(tmpdir(), 'decltr-two-'));

// 1. The server, on its own port and folder.
const config = loadConfig({ DECLTR_PORT: String(PORT), DECLTR_DATA_DIR: join(work, 'data') });
const store = await openSharedStore(join(config.dataDir, 'shared'));
const server = createApp({ config, getApiKey: async () => null, store });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// 2. A copy of the extension that talks to that port. It keeps the pinned "key", so its ID is the one the server allows.
const ext = join(work, 'extension');
cpSync(join(here, '..', '..', 'extension'), ext, { recursive: true });
const api = join(ext, 'lib', 'api.js');
writeFileSync(api, readFileSync(api, 'utf8').replace("'http://127.0.0.1:47821'", `'http://127.0.0.1:${PORT}'`));
const manifestPath = join(ext, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = [`http://127.0.0.1:${PORT}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

async function open(name, binary) {
  const browser = launchChromePipe({ binary, profileDir: join(work, `profile-${name}`) });
  await sleep(4000);
  const id = await browser.loadExtension(ext);
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(2000);
  const ev = (code) => page.evaluate(`(async () => { ${code} })()`, { timeout: 60_000 });
  return { browser, ev, id };
}

const names = `const { loadSessions } = await import('./lib/sessions.js'); return (await loadSessions()).map((s) => s.name).sort();`;
const waitFor = async (b, code, test, ms = 15_000) => {
  const started = Date.now();
  let value;
  while (Date.now() - started < ms) {
    value = await b.ev(code);
    if (test(value)) return { value, ms: Date.now() - started };
    await sleep(500);
  }
  return { value, ms: null };
};

let chrome;
let edge;
try {
  chrome = await open('chrome', CHROME);
  edge = await open('edge', EDGE);
  check('both browsers load the same extension ID', chrome.id === edge.id && chrome.id === 'jldfhgcphcbkmjmlkkioebphdaipkcjf', `${chrome.id} / ${edge.id}`);

  // Chrome has a session; both turn sharing on.
  await chrome.ev(`
    const { buildSession, saveSession } = await import('./lib/sessions.js');
    await saveSession(buildSession({ name: 'Lisbon trip', tabs: [
      { id: 1, url: 'https://flights.example/lis', title: 'Flights', groupId: -1 },
      { id: 2, url: 'https://hotels.example/lis', title: 'Hotels', groupId: -1 },
    ], groups: new Map() }));
    const { turnOnSharing } = await import('./lib/share.js');
    return turnOnSharing();`);
  const edgeOn = await edge.ev(`const { turnOnSharing } = await import('./lib/share.js'); return turnOnSharing();`);
  check('Edge turns sharing on and gets Chrome\'s session', edgeOn.ok && JSON.stringify(await edge.ev(names)) === '["Lisbon trip"]', JSON.stringify(edgeOn));
  const meNames = [await chrome.ev(`const { getShare } = await import('./lib/share.js'); return (await getShare()).me.name;`), await edge.ev(`const { getShare } = await import('./lib/share.js'); return (await getShare()).me.name;`)];
  check('each browser calls itself by its real name', meNames[0] === 'Google Chrome' && meNames[1] === 'Microsoft Edge', meNames.join(' / '));

  // Automatic: save in Edge, and nothing else. Chrome's panel shows the Sessions tab, which syncs every few seconds.
  await chrome.ev(`document.querySelector('#navSessions').click(); return true;`);
  await edge.ev(`
    const { buildSession, saveSession } = await import('./lib/sessions.js');
    await saveSession(buildSession({ name: 'Saved in Edge', tabs: [{ id: 1, url: 'https://edge.example/', title: 'E', groupId: -1 }], groups: new Map() }));
    return true;`);
  const arrived = await waitFor(chrome, names, (v) => v.includes('Saved in Edge'));
  check('a session saved in Edge appears in Chrome by itself', arrived.ms !== null, `after ${arrived.ms} ms`);
  const label = await waitFor(chrome, `return [...document.querySelectorAll('.session')].map((c) => c.querySelector('.session-meta').textContent).find((t) => t.includes('from')) ?? '';`, (v) => v.includes('from Microsoft Edge'), 8000);
  check('Chrome shows where it came from', label.ms !== null, label.value);

  // Rename in Chrome; Edge's Sessions tab is not open there, so it gets it when its window gets focus or on its next sync.
  await chrome.ev(`
    const { loadSessions, renameSession } = await import('./lib/sessions.js');
    const s = (await loadSessions()).find((x) => x.name === 'Lisbon trip');
    await renameSession(s.id, 'Lisbon 2027');
    return true;`);
  await sleep(2500); // Chrome's background sends it about a second later
  await edge.ev(`const { syncNow } = await import('./lib/share.js'); return syncNow();`);
  check('a rename in Chrome reaches Edge', (await edge.ev(names)).includes('Lisbon 2027'));

  // Live: Chrome opens it live, Edge sees "Live in Google Chrome", then takes it over.
  const liveId = await chrome.ev(`
    const { loadSessions } = await import('./lib/sessions.js');
    const { openTracked } = await import('./lib/session-ops.js');
    const s = (await loadSessions()).find((x) => x.name === 'Lisbon 2027');
    const win = await chrome.windows.getCurrent();
    const info = await openTracked(s, { target: 'new', windowId: win.id });
    const { syncNow } = await import('./lib/share.js');
    await syncNow();
    return info.tracking ? s.id : null;`);
  await edge.ev(`const { syncNow } = await import('./lib/share.js'); return syncNow();`);
  const elsewhere = await edge.ev(`const { getShare, liveElsewhere } = await import('./lib/share.js'); return liveElsewhere(await getShare(), ${JSON.stringify(liveId)})?.name ?? null;`);
  check('Edge sees the session is live in Chrome', elsewhere === 'Google Chrome', String(elsewhere));
  const takeOver = await edge.ev(`
    const { loadSessions } = await import('./lib/sessions.js');
    const { openTracked } = await import('./lib/session-ops.js');
    const s = (await loadSessions()).find((x) => x.id === ${JSON.stringify(liveId)});
    const win = await chrome.windows.getCurrent();
    const plain = await openTracked(s, { target: 'new', windowId: win.id });
    const moved = await openTracked(s, { target: 'new', windowId: win.id, takeOver: true });
    const { syncNow } = await import('./lib/share.js');
    await syncNow();
    return { plain: plain.tracking, plainSays: plain.liveElsewhere, moved: moved.tracking };`);
  check('opening it in Edge does not sync, "Sync here instead" does', takeOver.plain === false && takeOver.plainSays === 'Google Chrome' && takeOver.moved === true, JSON.stringify(takeOver));
  await chrome.ev(`const { syncNow } = await import('./lib/share.js'); return syncNow();`);
  const chromeLinks = await chrome.ev(`const { getLinks } = await import('./lib/tracker.js'); return Object.keys(await getLinks()).length;`);
  check('Chrome stops following its window once Edge took over', chromeLinks === 0, `${chromeLinks} window(s) still linked`);

  // Delete in Edge; Chrome removes it too.
  await edge.ev(`
    const { loadSessions, deleteSession } = await import('./lib/sessions.js');
    const s = (await loadSessions()).find((x) => x.name === 'Saved in Edge');
    await deleteSession(s.id);
    return true;`);
  await sleep(2500);
  await chrome.ev(`const { syncNow } = await import('./lib/share.js'); return syncNow();`);
  check('a deletion in Edge reaches Chrome', JSON.stringify(await chrome.ev(names)) === '["Lisbon 2027"]', JSON.stringify(await chrome.ev(names)));

  // The server's folder.
  const summary = store.summary();
  check('the server keeps one shared session from two browsers', summary.sessions === 1 && summary.browsers === 2, JSON.stringify(summary));
} catch (e) {
  check('no errors', false, e.stack ?? e.message);
} finally {
  chrome?.browser.child.kill();
  edge?.browser.child.kill();
  await new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  });
  rmSync(work, { recursive: true, force: true });
}
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(0);
