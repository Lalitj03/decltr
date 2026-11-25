// Minimal Chrome DevTools Protocol driver (Node 22 has a global WebSocket and fetch).
// Just enough to open a page, run code with a real user gesture, and read results.
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ profileDir, port = 9333, extraArgs = [] }) {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=900,700', '--window-position=40,40',
      ...extraArgs, 'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return { child, port, version: v.Browser };
    } catch {
      await sleep(500);
    }
  }
  child.kill();
  throw new Error('Chrome did not start');
}

export async function openPage(port, url) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable');
  return {
    targetId: target.id,
    /** Run an async expression in the page. userGesture grants the user activation that model download requires. */
    async evaluate(expression, { userGesture = false, timeout = 120_000 } = {}) {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }),
        sleep(timeout).then(() => { throw new Error(`evaluate timed out after ${timeout} ms`); }),
      ]);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: () => ws.close(),
  };
}
