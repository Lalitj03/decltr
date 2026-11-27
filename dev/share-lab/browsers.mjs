// What sharing and export/import depend on, checked in real Chrome and Edge (throwaway profiles):
//  - the extension ID and the Origin each browser sends to a local server
//  - which browser it is (for labels like "Live in Edge")
//  - whether an extension page can save a file with <a download>
//  - the storage quota, and which file pickers exist
//   node dev/share-lab/browsers.mjs
import http from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, EDGE, launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the Decltr server that records the Origin of every request.
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, origin: req.headers.origin ?? '(none)', host: req.headers.host });
  res.writeHead(200, {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST',
    'content-type': 'application/json',
  }).end('{"ok":true}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

async function check(name, binary) {
  const downloads = mkdtempSync(join(tmpdir(), 'decltr-share-dl-'));
  const browser = launchChromePipe({ binary, profileDir: mkdtempSync(join(tmpdir(), 'decltr-share-')) });
  const out = { browser: name };
  try {
    await sleep(4000);
    const id = await browser.loadExtension(join(here, '..', '..', 'extension'));
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
    await sleep(1500);
    const before = seen.length;
    Object.assign(out, await page.evaluate(`(async () => {
      const r = await fetch('http://127.0.0.1:${port}/v1/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return {
        id: chrome.runtime.id,
        brands: (navigator.userAgentData?.brands ?? []).map((b) => b.brand).filter((b) => !/not.?a.?brand/i.test(b)),
        fetchOk: r.ok,
        quotaMb: chrome.storage.local.QUOTA_BYTES / 1048576,
        showOpenFilePicker: typeof window.showOpenFilePicker,
        showSaveFilePicker: typeof window.showSaveFilePicker,
      };
    })()`));
    out.originsSeen = [...new Set(seen.slice(before).map((s) => `${s.method} ${s.origin}`))];
    // Save a file the way an export would: a Blob and an <a download> link, no downloads permission.
    await page.evaluate(`(() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'decltr-sessions', version: 1 })], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'Decltr sessions test.json' });
      document.body.append(a); a.click(); a.remove();
      return true;
    })()`, { userGesture: true });
    await sleep(2500);
    out.downloaded = readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'));
  } catch (e) {
    out.error = e.message;
  } finally {
    browser.child.kill();
    await sleep(500);
  }
  return out;
}

const results = [await check('Chrome', CHROME), await check('Edge', EDGE)];
server.close();
console.log(JSON.stringify(results, null, 2));
process.exit(0);
