// Follow-up to run.mjs: does an unloaded tab come back when it is shown, and what does a tab
// that is unloaded before its page sent a title look like?
//   node dev/lazy-open-lab/wake.mjs
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = new Map();
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (path === '/favicon.ico') return res.writeHead(204).end();
  const n = path.split('/').pop();
  const html = `<!doctype html><title>Page ${n}</title><h1>Page ${n}</h1>`;
  if (path.startsWith('/slow/')) {
    // Headers now, the page (and its title) 2 seconds later: like a slow site.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write(' '.repeat(2048));
    setTimeout(() => res.end(html), 2000);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-lazy-')) });
const out = {};
try {
  await sleep(3000);
  const id = await browser.loadExtension(join(here, '..', '..', 'extension'));
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(1500);
  const ev = (code) => page.evaluate(`(async () => { ${code} })()`, { timeout: 60_000 });
  Object.assign(out, await ev(`
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const win = (await chrome.windows.create({ focused: true, url: 'about:blank' })).id;
    const waitFor = async (id, test, ms = 8000) => {
      for (let t = 0; t < ms; t += 20) { const x = await chrome.tabs.get(id).catch(() => null); if (x && test(x)) return x; await sleep(20); }
      return chrome.tabs.get(id).catch(() => null);
    };
    const open = async (path, ready) => {
      const t = await chrome.tabs.create({ windowId: win, url: '${base}' + path, active: false });
      await waitFor(t.id, ready);
      return (await chrome.tabs.discard(t.id)).id;
    };
    const look = async (id) => { const x = await chrome.tabs.get(id); return { title: x.title, url: x.url, discarded: x.discarded, status: x.status }; };
    const result = {};

    // 1. Unloaded after its title arrived, then made the active tab of the focused window.
    const a = await open('/fast/1', (x) => x.title === 'Page 1');
    await chrome.windows.update(win, { focused: true });
    await chrome.tabs.update(a, { active: true });
    result.activated = await look((await waitFor(a, (x) => !x.discarded && x.status === 'complete')).id);

    // 2. Unloaded, then reloaded by the extension.
    const b = await open('/fast/2', (x) => x.title === 'Page 2');
    await chrome.tabs.reload(b);
    result.reloaded = await look((await waitFor(b, (x) => !x.discarded && x.status === 'complete')).id);

    // 3. Unloaded as soon as the address is known, before the slow page sent its title.
    const c = await open('/slow/3', (x) => (x.url || '').includes('/slow/3'));
    result.earlyUnload = await look(c);
    await chrome.tabs.update(c, { active: true });
    result.earlyUnloadWoken = await look((await waitFor(c, (x) => !x.discarded && x.status === 'complete' && x.title === 'Page 3')).id);
    return result;
  `));
  out.serverHits = Object.fromEntries([...hits.entries()].filter(([p]) => p !== '/favicon.ico'));
} catch (e) {
  out.error = e.message;
} finally {
  browser.child.kill();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
