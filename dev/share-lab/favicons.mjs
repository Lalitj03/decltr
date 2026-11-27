// Does the panel show tab icons without contacting any site or icon service? Runs the real extension in real
// Chrome and Edge, behind a proxy that writes down every connection the browser tries and lets none through.
//   node dev/share-lab/favicons.mjs
// It saves a session whose stored icon addresses point at the sites (as older versions loaded them), opens the
// Sessions view with that session expanded, and checks that:
//   - every tab icon comes from the browser's own icon store ("_favicon", the "favicon" permission),
//   - a page the browser has seen shows its icon, and a page it has never seen shows the default icon,
//   - the sites are contacted 0 times, and the browser's network log has nothing about those tabs (no request,
//     no host lookup, no icon service asked on their behalf),
//   - the "favicon" permission adds no install warning (the "tabs" warning already covers it).
// A last step loads one icon straight from a site, as the old code did, to show both checks would notice it.
// The browsers' own background connections (search engine, updates, Edge diagnostics) are listed, not counted.
import http from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, EDGE, launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mP8z8BQz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC', 'base64');

// The "site": one page with an icon, plus the icon address a stored session points at.
const hits = { icon: 0, stored: 0 };
const site = http.createServer((req, res) => {
  const png = () => res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(ICON);
  if (req.url.startsWith('/icon.png')) return hits.icon++, png();
  if (req.url.startsWith('/stored-icon.png')) return hits.stored++, png();
  res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Icon page</title><link rel="icon" href="/icon.png"><h1>hi</h1>');
});
await listen(site);
const base = `http://127.0.0.1:${site.address().port}`;
const page = `${base}/page`;

// Everything except this computer (127.0.0.1 is never sent to a proxy) has to go through here.
const tried = [];
const proxy = http.createServer((req, res) => {
  tried.push(req.url);
  res.writeHead(502).end();
});
proxy.on('connect', (req, socket) => {
  tried.push(req.url);
  socket.on('error', () => {});
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});
await listen(proxy);

const work = mkdtempSync(join(tmpdir(), 'decltr-fav-'));
const ext = join(work, 'extension');
cpSync(join(here, '..', '..', 'extension'), ext, { recursive: true });
const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
if (!m.permissions.includes('favicon')) throw new Error('extension/manifest.json has no "favicon" permission');
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(m));

const probes = [1, 2, 3, 4, 5].map((i) => `decltr-probe-${i}.example`);
const session = {
  id: '0f0f0f0f-0000-4000-8000-00000000fa01', name: 'Icon check', nameSource: 'user', createdAt: Date.now(), updatedAt: Date.now(), groups: [],
  tabs: [
    { url: page, title: 'Icon page', favIcon: `${base}/stored-icon.png`, pinned: false, g: -1 },
    ...probes.map((host, i) => ({ url: `https://${host}/page`, title: `Never visited ${i + 1}`, favIcon: `https://${host}/favicon.ico`, pinned: false, g: -1 })),
  ],
};

let failed = false;
for (const [name, binary] of [['Chrome', CHROME], ['Edge', EDGE]]) {
  // The browser's network log records every request and host lookup it makes, with the full address,
  // including any icon service it might ask on our behalf (it would carry the page address).
  const netLog = join(work, `${name}-net.json`);
  const browser = launchChromePipe({
    binary, profileDir: join(work, name),
    extraArgs: [`--proxy-server=http://127.0.0.1:${proxy.address().port}`, `--log-net-log=${netLog}`, '--net-log-capture-mode=Default'],
  });
  let result;
  try {
    await sleep(4000);
    const id = await browser.loadExtension(ext);
    const setup = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
    await sleep(1500);
    // The install warnings the browser shows for this manifest, with and without "favicon".
    const without = { ...m, permissions: m.permissions.filter((p) => p !== 'favicon') };
    const warnings = await setup.evaluate(`(async () => ({
      with: await chrome.management.getPermissionWarningsByManifest(${JSON.stringify(JSON.stringify(m))}),
      without: await chrome.management.getPermissionWarningsByManifest(${JSON.stringify(JSON.stringify(without))}),
    }))()`);
    // Visit the page once, so the browser knows its icon, then close it. Then save the session.
    await setup.evaluate(`(async () => {
      const t = await chrome.tabs.create({ url: ${JSON.stringify(page)}, active: false });
      await new Promise((r) => setTimeout(r, 2500));
      await chrome.tabs.remove(t.id);
      await chrome.storage.local.set({ ${JSON.stringify(`decltr.session.${session.id}`)}: ${JSON.stringify(session)} });
    })()`);
    // Opening a tab makes browsers connect to their search engine ahead of time, so let that pass first.
    const panel = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
    await panel.evaluate(`(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      document.querySelector('#navSessions').click();
    })()`);
    await sleep(5000);
    const quietFrom = tried.length;
    await sleep(6000);
    const quiet = tried.slice(quietFrom);

    // Three rounds of showing the session's icons: expand it (new images each time), wait, collapse.
    const before = { ...hits };
    const from = tried.length;
    let icons;
    for (let round = 0; round < 3; round++) {
      await panel.evaluate(`[...document.querySelectorAll('.session')].find((c) => c.textContent.includes('Icon check')).querySelector('.expand').click()`);
      await sleep(1500);
      icons = await panel.evaluate(`(() => {
        const all = [...document.querySelectorAll('img.fav')].map((img) => img.getAttribute('src') ?? '');
        const rows = [...document.querySelectorAll('li.tab-item[title]')].map((li) => ({ url: li.title, width: li.querySelector('img.fav')?.naturalWidth ?? 0 }));
        return { all, rows };
      })()`);
      await panel.evaluate(`[...document.querySelectorAll('.session')].find((c) => c.textContent.includes('Icon check')).querySelector('.expand').click()`);
      await sleep(500);
    }
    const during = tried.slice(from);

    // Positive control: what the old code did, an icon loaded from the site's own address.
    const controlFrom = tried.length;
    await panel.evaluate(`(() => { const img = new Image(); img.src = 'https://decltr-probe-control.example/favicon.ico'; document.body.append(img); })()`);
    await sleep(2500);
    const noticed = tried.slice(controlFrom).some((t) => t.includes('decltr-probe-control.example'));
    result = { id, icons, before, during, quiet, noticed, warnings };
  } catch (e) {
    failed = true;
    console.log(`${name}: ${e.message}`);
  } finally {
    const exited = new Promise((r) => browser.child.once('exit', r));
    browser.child.kill();
    await Promise.race([exited, sleep(8000)]);
  }
  if (!result) continue;

  const { id, icons, before, during, quiet, noticed, warnings } = result;
  const sameWarnings = JSON.stringify(warnings.with) === JSON.stringify(warnings.without);
  const lines = readFileSync(netLog, 'utf8').split('\n');
  const mentions = (re) => lines.filter((l) => re.test(l) && !l.includes('chrome-extension://'));
  const aboutTabs = mentions(/decltr-probe-[1-5]\.example|stored-icon\.png/);
  const logSeesControl = mentions(/decltr-probe-control\.example/).length > 0;
  const prefix = `chrome-extension://${id}/_favicon/`;
  const fromStore = icons.all.length > 0 && icons.all.every((src) => src.startsWith(prefix));
  const seen = icons.rows.find((r) => r.url === page);
  const unseen = icons.rows.filter((r) => r.url !== page);
  const probeTried = during.filter((t) => t.includes('decltr-probe-'));
  const ok = fromStore && seen?.width > 0 && unseen.length === probes.length && unseen.every((r) => r.width > 0)
    && hits.icon === before.icon && hits.stored === 0 && probeTried.length === 0 && aboutTabs.length === 0 && noticed && logSeesControl
    && sameWarnings;
  failed ||= !ok;
  console.log(`${name}: ${ok ? 'OK' : 'PROBLEM'}`);
  console.log(`  install warnings: ${warnings.with.join(' / ')}; the same without "favicon": ${sameWarnings ? 'yes' : `NO (${warnings.without.join(' / ')})`}`);
  console.log(`  ${icons.all.length} tab icons shown, all from the browser's icon store: ${fromStore ? 'yes' : 'NO'}`);
  console.log(`  visited page shows its icon: ${seen?.width > 0 ? 'yes' : 'NO'}; ${unseen.filter((r) => r.width > 0).length} of ${probes.length} never-visited pages show the default icon`);
  console.log(`  site contacted for icons: ${hits.icon - before.icon} times for its icon, ${hits.stored} times for the stored icon address`);
  console.log(`  network log entries about the session's tabs (requests, host lookups, icon services): ${aboutTabs.length}`);
  if (aboutTabs.length) console.log(`    ${aboutTabs.slice(0, 5).map((l) => l.slice(0, 300)).join('\n    ')}`);
  console.log(`  connections tried while the icons showed: ${during.length ? during.join(', ') : 'none'}`);
  console.log(`  (doing nothing for as long: ${quiet.length ? quiet.join(', ') : 'none'})`);
  console.log(`  an icon loaded from a site, as before this change, is noticed by the proxy: ${noticed ? 'yes' : 'NO'}, and in the network log: ${logSeesControl ? 'yes' : 'NO'}`);
}
site.close();
proxy.close();
rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
