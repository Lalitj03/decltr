// Does rewriting the Origin header let an extension talk to a server that rejects extension origins?
// Run: node dev/dnr-lab/run.mjs   (opens a separate Chrome with a throwaway profile; nothing of yours is touched)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [11999, 11998].map((port) => spawn('node', [join(here, '..', 'fake-model-server.mjs'), '--port', String(port)], { stdio: 'ignore' }));
await sleep(800);

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-dnr-')) });
await sleep(3000);
const out = {};
try {
  const id = await browser.loadExtension(join(here, 'ext'));
  const page = await browser.openPage(`chrome-extension://${id}/lab.html`);
  await sleep(1200);
  const call = (url) => page.evaluate(`window.__lab.call(${JSON.stringify(url)})`);
  const A = 'http://127.0.0.1:11999', B = 'http://127.0.0.1:11998';

  out['1. no rule: extension is rejected like Ollama does'] = await call(`${A}/api/chat`);
  out['2. rule set for A'] = { rulesInstalled: await page.evaluate(`window.__lab.setRule(${JSON.stringify(A)})`) };
  out['3. with rule: same request to A'] = await call(`${A}/api/chat`);
  out['4. with rule: server B is a different address, rule must not apply'] = await call(`${B}/api/chat`);
  await page.evaluate('window.__lab.clearRule()');
  out['5. rule removed: A is rejected again'] = await call(`${A}/api/chat`);

  const log = await (await fetch(`${A}/__log`)).json().catch(() => []);
  out['what server A actually received (Origin header per request)'] = log.filter((e) => e.url === '/api/chat').map((e) => `${e.origin} -> ${e.status}`);
  out['what server B received'] = (await (await fetch(`${B}/__log`)).json().catch(() => [])).filter((e) => e.url === '/api/chat').map((e) => `${e.origin} -> ${e.status}`);
} catch (e) {
  out.FAILED = e.message;
} finally {
  browser.child.kill();
  servers.forEach((s) => s.kill());
}
console.log(JSON.stringify(out, null, 2));
