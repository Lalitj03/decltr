// The shipped code in a real Chrome: open a 200-tab session with the extension's own openSession,
// and check memory, titles, groups, waking a tab up, live syncing, and undo.
//   node dev/lazy-open-lab/real-open.mjs [tabs=200]
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] ?? 200);

// Pages that weigh about 30 MB each, like real sites. Every 10th page is slow to send its title.
const hits = new Map();
const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (path === '/favicon.ico') return res.writeHead(204).end();
  const n = Number(path.split('/').pop());
  const html = `<!doctype html><title>Real page ${n}</title><script>window.weight = Array.from({ length: 4e6 }, (_, i) => i * 1.5);</script><h1>${n}</h1>`;
  if (n % 10 === 5) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write(' '.repeat(4096));
    setTimeout(() => res.end(html), 5000);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-realopen-')) });
const memoryMb = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
  let total = 0;
  const walk = (pid) => {
    total += rss.get(pid) ?? 0;
    for (const k of kids.get(pid) ?? []) walk(k);
  };
  walk(browser.child.pid);
  return Math.round(total / 1024);
};

const out = {};
try {
  await sleep(3000);
  const id = await browser.loadExtension(join(here, '..', '..', 'extension'));
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(1500);
  const ev = (code, timeout = 600_000) => page.evaluate(`(async () => { ${code} })()`, { timeout });
  out.memoryBefore = memoryMb();

  // A saved session with 3 groups, built the way the panel builds one.
  await ev(`
    const { buildSession, saveSession } = await import('./lib/sessions.js');
    const groups = new Map([[1, { title: 'Alpha', color: 'blue', collapsed: true }], [2, { title: 'Beta', color: 'red', collapsed: false }], [3, { title: 'Gamma', color: 'green', collapsed: true }]]);
    const tabs = Array.from({ length: ${N} }, (_, i) => ({ id: i + 1, url: '${base}/p/' + i, title: 'Real page ' + i, favIconUrl: '', groupId: i < 50 ? 1 : i < 120 ? 2 : i < 150 ? 3 : -1, lastAccessed: Date.now() - i * 3600e3 }));
    window.__session = buildSession({ name: 'Lab', tabs, groups });
    await saveSession(window.__session);
  `);

  // Open it the way the Sessions tab does, sampling memory while it opens.
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, memoryMb())), 500);
  const started = Date.now();
  out.open = await ev(`
    const { openTracked } = await import('./lib/session-ops.js');
    const win = await chrome.windows.getCurrent();
    window.__info = await openTracked(window.__session, { target: 'new', windowId: win.id });
    const i = window.__info;
    return { created: i.createdIds.length, unloaded: i.unloaded, tracking: i.tracking, failed: i.failed.length };
  `);
  out.open.seconds = (Date.now() - started) / 1000;
  clearInterval(sampler);
  out.open.peakMemoryMb = peak;
  await sleep(5000);
  out.memoryAfterOpen = memoryMb();
  out.pagesFetched = [...hits.keys()].filter((p) => p.startsWith('/p/')).length;

  out.state = await ev(`
    const tabs = await chrome.tabs.query({ windowId: window.__info.windowId });
    const groups = await chrome.tabGroups.query({ windowId: window.__info.windowId });
    return {
      tabs: tabs.length,
      inOrder: tabs.every((t, i) => t.url === '${base}/p/' + i),
      realTitles: tabs.filter((t) => t.title.startsWith('Real page')).length,
      addressAsTitle: tabs.filter((t) => !t.title.startsWith('Real page')).length,
      unloaded: tabs.filter((t) => t.discarded).length,
      activeLoaded: tabs.filter((t) => t.active && !t.discarded).length,
      groups: groups.map((g) => ({ title: g.title, collapsed: g.collapsed, tabs: tabs.filter((t) => t.groupId === g.id).length })),
    };
  `);

  // Click an unloaded tab: it loads.
  out.wake = await ev(`
    const tabs = await chrome.tabs.query({ windowId: window.__info.windowId });
    const t = tabs[160];
    await chrome.windows.update(window.__info.windowId, { focused: true });
    await chrome.tabs.update(t.id, { active: true });
    for (let k = 0; k < 50; k++) {
      const now = await chrome.tabs.get(t.id);
      if (!now.discarded && now.status === 'complete') return { url: now.url, title: now.title, discarded: now.discarded };
      await new Promise((r) => setTimeout(r, 200));
    }
    const now = await chrome.tabs.get(t.id);
    return { url: now.url, title: now.title, discarded: now.discarded, status: now.status };
  `);

  // Live syncing: the background worker saves the window. Titles of tabs that show their address must survive.
  await ev(`
    const tabs = await chrome.tabs.query({ windowId: window.__info.windowId });
    await chrome.tabs.move(tabs[199].id, { index: 150 }); // a real change, so the worker syncs
  `);
  await sleep(4000);
  out.liveSync = await ev(`
    const { loadSessions } = await import('./lib/sessions.js');
    const s = (await loadSessions()).find((x) => x.id === window.__session.id);
    return { tabs: s.tabs.length, realTitles: s.tabs.filter((t) => t.title.startsWith('Real page')).length, movedTabNowAt150: s.tabs[150].url.endsWith('/p/199'), withLastUsed: s.tabs.filter((t) => t.used).length };
  `);

  // Undo closes the window.
  out.undo = await ev(`
    const { undoTrackedOpen } = await import('./lib/session-ops.js');
    await undoTrackedOpen(window.__info);
    await new Promise((r) => setTimeout(r, 500));
    return { windowGone: !(await chrome.windows.getAll()).some((w) => w.id === window.__info.windowId) };
  `);
} catch (e) {
  out.error = e.message;
} finally {
  browser.child.kill();
  server.close();
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
