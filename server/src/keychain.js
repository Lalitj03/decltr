import { execFile, spawn } from 'node:child_process';

// API keys live in the macOS login Keychain under service "decltr", one entry per
// provider. On other platforms, or if you prefer, set DECLTR_API_KEY in the
// server's environment.
const SERVICE = 'decltr';
// Before the product was renamed the service was "declt". Keys stored then are still found and
// copied to the new name the first time they are read, so nothing has to be entered again.
const LEGACY_SERVICE = 'declt';
export const ACCOUNTS = { vertex: 'vertex-api-key', gemini: 'gemini-api-key' };

// Gemini keys look like "AIza...", Vertex AI keys like "AQ.Ab8...". Both are
// URL-safe characters plus "." and "-". Rejecting anything else also makes it
// safe to hand the value to `security -i` below (no spaces, quotes or newlines).
const KEY_PATTERN = /^[A-Za-z0-9._-]{20,128}$/;

export function isValidKeyFormat(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function accountFor(provider) {
  const account = ACCOUNTS[provider];
  if (!account) throw new Error(`Unknown provider "${provider}".`);
  return account;
}

/** The real macOS Keychain, through the `security` command. Swappable so tests never touch it. */
export const macKeychain = {
  find: (service, account) =>
    new Promise((resolve) => {
      execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    }),

  // `security -i` reads commands from stdin, so the key never appears in the
  // process list (unlike passing it with -w on the command line).
  add: (service, account, key) =>
    new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`security exited with ${code}: ${stderr.replaceAll(key, '[redacted]')}`)),
      );
      child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -w ${key}\n`);
    }),
};

export async function readApiKey(provider, env = process.env, keychain = macKeychain) {
  const account = accountFor(provider);
  if (env.DECLTR_API_KEY) {
    const key = env.DECLTR_API_KEY.trim();
    return isValidKeyFormat(key) ? key : null;
  }
  if (keychain === macKeychain && process.platform !== 'darwin') return null;

  const current = await keychain.find(SERVICE, account);
  if (isValidKeyFormat(current)) return current;

  const previous = await keychain.find(LEGACY_SERVICE, account);
  if (!isValidKeyFormat(previous)) return null;
  // Best effort: if copying fails the key still works, it is just looked up the old way next time too.
  await keychain.add(SERVICE, account, previous).catch(() => {});
  return previous;
}

export async function storeApiKey(provider, key, keychain = macKeychain) {
  const account = accountFor(provider);
  if (!isValidKeyFormat(key)) throw new Error('That does not look like an API key.');
  if (keychain === macKeychain && process.platform !== 'darwin') {
    throw new Error('Keychain storage is only available on macOS. Set DECLTR_API_KEY instead.');
  }
  await keychain.add(SERVICE, account, key);
}
