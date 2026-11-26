// What does Chrome report as tab.lastAccessed for: a tab opened in the background, a tab that was
// used and then unloaded, and all of them after the browser restarts and restores its tabs?
//   node dev/lazy-open-lab/last-used.mjs
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Page ${req.url}</title><h1>${req.url}</h1>`));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profileDir = mkdtempSync(join(tmpdir(), 'decltr-lastused-'));
const ext = join(here, '..', '..', 'extension');
const out = {};

async function session(extraArgs, fn) {
  const browser = launchChromePipe({ profileDir, extraArgs });
  try {
    await sleep(3000);
    const id = await browser.loadExtension(ext);
    const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
    await sleep(1200);
    return await fn((code) => page.evaluate(`(async () => { ${code} })()`, { timeout: 60_000 }));
  } finally {
    await browser.send('Browser.close').catch(() => {});
    await sleep(1500);
    browser.child.kill();
    await sleep(1000);
  }
}

const read = `
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  return tabs.filter((t) => (t.url || '').includes('/lab/')).map((t) => ({
    path: new URL(t.url).pathname, discarded: t.discarded, ageSeconds: t.lastAccessed ? Math.round((now - t.lastAccessed) / 1000) : null,
  }));`;

out.firstRun = await session([], async (ev) => {
  return ev(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const win = (await chrome.windows.create({ focused: true, url: '${base}/lab/a-used-first' })).id;
    await sleep(3000);
    const bg = await chrome.tabs.create({ windowId: win, url: '${base}/lab/b-background-never-used', active: false });
    await sleep(3000);
    const c = await chrome.tabs.create({ windowId: win, url: '${base}/lab/c-used-second', active: true });
    await sleep(3000);
    const d = await chrome.tabs.create({ windowId: win, url: '${base}/lab/d-used-then-unloaded', active: true });
    await sleep(3000);
    const e = await chrome.tabs.create({ windowId: win, url: '${base}/lab/e-used-last', active: true });
    await sleep(2000);
    await chrome.tabs.discard(d.id);
    await sleep(12000); // give Chrome time to save its session
    ${read}
  `);
});

// Relaunch the same profile and restore the previous session, a few seconds later.
await sleep(10000);
out.afterRestart = await session(['--restore-last-session'], async (ev) => {
  await sleep(2000);
  return ev(read);
});
server.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
