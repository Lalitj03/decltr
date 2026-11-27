// Renders the store graphics (dev/store/frame.html) into store/, and the panel images that show Ollama set up,
// in a headless Chrome with a temporary profile and the dev preview on its own port.
//   node dev/store/capture.mjs           panel images, then every store graphic
//   node dev/store/capture.mjs frames    only the store graphics, from the panel images already in dev/store/
// The plan, sessions and big-window panel images are screenshots of the preview taken by hand (440x800).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from '../builtin-ai-lab/cdp-pipe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 5199;

const panels = [
  // The start screen with Ollama on this computer: "Runs on this computer", "Nothing leaves your computer".
  { out: 'dev/store/panel-privacy.png', url: '/panel?ai=ollama&tabs=many', size: [440, 800] },
  // Settings open, with Ollama chosen.
  { out: 'dev/store/panel-ai.png', url: '/panel?ai=ollama', size: [440, 800], steps: ["document.querySelector('#settingsBtn').click()"] },
];
const frames = [
  ...[1, 2, 3, 4, 5].map((n) => ({ out: `store/screenshot-${n}.png`, url: `/dev/store/frame.html?n=${n}`, size: [1280, 800] })),
  { out: 'store/promo-440x280.png', url: '/dev/store/frame.html?promo', size: [440, 280] },
  { out: 'store/promo-1400x560.png', url: '/dev/store/frame.html?large', size: [1400, 560] },
  { out: 'store/social-1280x640.png', url: '/dev/store/frame.html?social', size: [1280, 640] },
];

const server = spawn(process.execPath, [join(root, 'dev', 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('UI preview') && resolve());
  server.on('exit', (code) => reject(new Error(`the preview server stopped (${code}); is port ${PORT} free?`)));
});
const profileDir = mkdtempSync(join(tmpdir(), 'decltr-capture-'));
const browser = launchChromePipe({ profileDir, extraArgs: ['--headless=new', '--hide-scrollbars', '--force-color-profile=srgb'] });

async function capture({ out, url, size: [width, height], steps = [] }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => browser.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${out}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${url}` });
  for (let i = 0; i < 100 && !(await evaluate("document.readyState === 'complete' && [...document.images].every((i) => i.complete)").catch(() => false)); i++) await sleep(100);
  await sleep(2500); // the preview's pretend server answers after half a second, then the panel draws
  for (const step of steps) {
    await evaluate(step);
    await sleep(800);
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, out), Buffer.from(data, 'base64'));
  await browser.send('Target.closeTarget', { targetId });
  console.log(`${out} (${width}x${height})`);
}

try {
  await sleep(1500);
  for (const job of [...(process.argv[2] === 'frames' ? [] : panels), ...frames]) await capture(job);
} finally {
  browser.child.kill();
  server.kill();
  await sleep(500);
  rmSync(profileDir, { recursive: true, force: true });
}
