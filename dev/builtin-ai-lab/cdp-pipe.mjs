// DevTools Protocol over a pipe. Needed because Chrome 137+ ignores --load-extension, while
// Extensions.loadUnpacked is only offered on a pipe connection with --enable-unsafe-extension-debugging.
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function launchChromePipe({ profileDir, extraArgs = [] }) {
  const child = spawn(
    CHROME,
    [
      '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=900,700', '--window-position=40,40', ...extraArgs, 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];

  let id = 0;
  const pending = new Map();
  let buffer = '';
  fromChrome.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      toChrome.write(`${JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });

  return {
    child,
    send,
    async loadExtension(path) {
      return (await send('Extensions.loadUnpacked', { path })).id;
    },
    async openPage(url) {
      const { targetId } = await send('Target.createTarget', { url });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Runtime.enable', {}, sessionId);
      return {
        async evaluate(expression, { userGesture = false, timeout = 120_000 } = {}) {
          const r = await Promise.race([
            send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId),
            sleep(timeout).then(() => {
              throw new Error(`evaluate timed out after ${timeout} ms`);
            }),
          ]);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        close: () => send('Target.closeTarget', { targetId }).catch(() => {}),
      };
    },
  };
}
