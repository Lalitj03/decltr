// Can a big session be opened without loading every tab? Compares, in a throwaway Chrome profile:
//   eager      : chrome.tabs.create for each tab (what Decltr does today)
//   discard    : create, then chrome.tabs.discard straight away
//   committed  : create, wait until Chrome reports the tab's URL, then discard
// and records memory, how many pages really loaded, and what a discarded tab looks like to the
// extension (url, title, status), because live session syncing reads exactly those fields.
//   node dev/lazy-open-lab/run.mjs [eagerCount=40] [lazyCount=200]
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EAGER = Number(process.argv[2] ?? 40);
const LAZY = Number(process.argv[3] ?? 200);

// A page that costs memory like a real site: about 30 MB of JavaScript objects.
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const hits = new Map();
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (path === '/favicon.ico') return res.writeHead(200, { 'content-type': 'image/png' }).end(ICON);
  const n = path.split('/').pop();
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Page ${n} of the lab</title>
    <script>window.weight = Array.from({ length: 4e6 }, (_, i) => i * 1.5);</script><h1>Page ${n}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const pageHits = (prefix) => [...hits.entries()].filter(([p]) => p.startsWith(prefix)).length;

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-lazy-')) });
const memoryMb = () => {
  // Every process Chrome started for this run is a descendant of the browser process.
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
  let total = 0;
  let processes = 0;
  const walk = (pid) => {
    total += rss.get(pid) ?? 0;
    processes++;
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(browser.child.pid);
  return { mb: Math.round(total / 1024), processes };
};

const out = {};
const step = (m) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
try {
  await sleep(3000);
  step('launched');
  const id = await browser.loadExtension(join(here, '..', '..', 'extension'));
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(1500);
  const ev = (code, timeout) => page.evaluate(`(async () => { ${code} })()`, { timeout });
  await ev(`window.__win = (await chrome.windows.create({ focused: false, url: 'about:blank' })).id;`);
  const closeLabTabs = () => ev(`const t = await chrome.tabs.query({ windowId: window.__win }); await chrome.tabs.remove(t.slice(1).map((x) => x.id));`);
  out.baseline = memoryMb();
  step('baseline ' + JSON.stringify(out.baseline));

  // ---- eager: today's behaviour -------------------------------------------
  let started = Date.now();
  await ev(`for (let i = 0; i < ${EAGER}; i++) await chrome.tabs.create({ windowId: window.__win, url: '${base}/eager/' + i, active: false });`, 300_000);
  out.eager = { tabs: EAGER, createMs: Date.now() - started };
  step('eager created');
  await sleep(8000);
  Object.assign(out.eager, memoryMb(), { pagesLoaded: pageHits('/eager/') });
  await closeLabTabs();
  await sleep(4000);

  // ---- discard straight after create --------------------------------------
  started = Date.now();
  await ev(`for (let i = 0; i < ${LAZY}; i++) {
      const t = await chrome.tabs.create({ windowId: window.__win, url: '${base}/discard/' + i, active: false });
      await chrome.tabs.discard(t.id).catch(() => {});
    }`, 600_000);
  out.discard = { tabs: LAZY, createMs: Date.now() - started };
  step('discard created');
  await sleep(8000);
  Object.assign(out.discard, memoryMb(), { pagesLoaded: pageHits('/discard/') });
  out.discard.looksLike = await ev(`const t = (await chrome.tabs.query({ windowId: window.__win })).slice(1);
      const ok = t.filter((x) => x.url && x.url.includes('/discard/')).length;
      const s = t[5];
      return { withUrl: ok, of: t.length, discarded: t.filter((x) => x.discarded).length, sample: { url: s.url, pendingUrl: s.pendingUrl, title: s.title, status: s.status, discarded: s.discarded } };`);
  // Grouping and collapsing unloaded tabs, then waking one up.
  out.discard.groupAndWake = await ev(`const t = (await chrome.tabs.query({ windowId: window.__win })).slice(1);
      const wake = t[Math.min(20, t.length - 1)];
      const g = await chrome.tabs.group({ tabIds: t.slice(0, 10).map((x) => x.id), createProperties: { windowId: window.__win } });
      await chrome.tabGroups.update(g, { title: 'Lab', collapsed: true });
      const after = await chrome.tabs.query({ groupId: g });
      const still = after.filter((x) => x.discarded).length;
      await chrome.tabs.update(wake.id, { active: true });
      await new Promise((r) => setTimeout(r, 2500));
      const woke = await chrome.tabs.get(wake.id);
      return { grouped: after.length, stillUnloaded: still, woke: { url: woke.url, title: woke.title, discarded: woke.discarded, status: woke.status } };`);
  out.discard.pagesLoadedAfterWake = pageHits('/discard/');
  await closeLabTabs();
  await sleep(4000);

  // ---- discard once the URL is known, 6 at a time -------------------------
  started = Date.now();
  out.committed = await ev(`
    const POOL = 6, N = ${LAZY}, timings = [], idChanged = [];
    let next = 0;
    async function one(i) {
      const t0 = performance.now();
      const t = await chrome.tabs.create({ windowId: window.__win, url: '${base}/committed/' + i, active: false });
      let committedAt = null, titledAt = null;
      for (let k = 0; k < 400; k++) {
        const now = await chrome.tabs.get(t.id);
        if (committedAt === null && now.url && now.url.startsWith('http')) committedAt = performance.now() - t0;
        if (now.title && !now.title.startsWith('127.0.0.1') && !now.title.startsWith('http')) { titledAt = performance.now() - t0; break; }
        await new Promise((r) => setTimeout(r, 15));
      }
      const d = await chrome.tabs.discard(t.id).catch(() => null);
      if (d && d.id !== t.id) idChanged.push([t.id, d.id]);
      timings.push({ committedAt, titledAt });
    }
    async function worker() { while (next < N) await one(next++); }
    await Promise.all(Array.from({ length: POOL }, worker));
    const avg = (k) => Math.round(timings.reduce((a, x) => a + (x[k] ?? 0), 0) / timings.length);
    return { tabs: N, avgCommitMs: avg('committedAt'), avgTitleMs: avg('titledAt'), idChanged: idChanged.length };
  `, 900_000);
  out.committed.createMs = Date.now() - started;
  step('committed created');
  await sleep(8000);
  Object.assign(out.committed, memoryMb(), { pagesLoaded: pageHits('/committed/') });
  out.committed.looksLike = await ev(`const t = (await chrome.tabs.query({ windowId: window.__win })).slice(1);
      const s = t[Math.min(5, t.length - 1)];
      return { withUrl: t.filter((x) => x.url && x.url.includes('/committed/')).length, withTitle: t.filter((x) => x.title && x.title.startsWith('Page')).length,
        withFavicon: t.filter((x) => x.favIconUrl).length, of: t.length, discarded: t.filter((x) => x.discarded).length,
        sample: { url: s.url, title: s.title, favIconUrl: s.favIconUrl, status: s.status, discarded: s.discarded } };`);
  out.committed.groupAndWake = await ev(`const t = (await chrome.tabs.query({ windowId: window.__win })).slice(1);
      const wake = t[Math.min(20, t.length - 1)];
      const g = await chrome.tabs.group({ tabIds: t.slice(0, 10).map((x) => x.id), createProperties: { windowId: window.__win } });
      await chrome.tabGroups.update(g, { title: 'Lab', collapsed: true });
      const still = (await chrome.tabs.query({ groupId: g })).filter((x) => x.discarded).length;
      await chrome.tabs.update(wake.id, { active: true });
      await new Promise((r) => setTimeout(r, 2500));
      const woke = await chrome.tabs.get(wake.id);
      return { stillUnloadedAfterGroupAndCollapse: still, woke: { url: woke.url, title: woke.title, discarded: woke.discarded, status: woke.status } };`);
  await closeLabTabs();
} catch (e) {
  out.error = e.message;
} finally {
  browser.child.kill();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
