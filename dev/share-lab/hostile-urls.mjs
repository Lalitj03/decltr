// An imported file can come from someone else. What happens if a session in it holds browser pages?
// Opens each address with chrome.tabs.create, the way opening a session does, in a throwaway profile.
//   node dev/share-lab/hostile-urls.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Quitting comes last, because if it works the browser is gone.
const URLS = ['chrome://settings/', 'chrome://crash/', 'chrome://kill/', 'chrome://hang/', 'javascript:alert(1)', 'chrome://restart/', 'chrome://quit/'];

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-hostile-')) });
let exited = null;
browser.child.on('exit', () => (exited = new Date().toISOString()));
const out = [];
try {
  await sleep(3500);
  const id = await browser.loadExtension(join(here, '..', '..', 'extension'));
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(1200);
  for (const url of URLS) {
    if (exited) {
      out.push({ url, result: 'browser already gone' });
      continue;
    }
    try {
      const r = await page.evaluate(`(async () => {
        try {
          const t = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false });
          await new Promise((r) => setTimeout(r, 1500));
          const now = await chrome.tabs.get(t.id).catch(() => null);
          return { created: true, stillThere: Boolean(now), shows: now?.url ?? now?.pendingUrl ?? null };
        } catch (e) {
          return { created: false, error: e.message };
        }
      })()`, { timeout: 8000 });
      out.push({ url, ...r });
    } catch (e) {
      await sleep(1500);
      out.push({ url, result: exited ? `the browser quit (${e.message})` : `no answer: ${e.message}` });
    }
  }
} finally {
  if (!exited) browser.child.kill();
}
console.log(JSON.stringify({ browserExited: Boolean(exited), results: out }, null, 2));
process.exit(0);
