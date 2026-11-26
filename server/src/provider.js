// Which Google API a key belongs to, and which one the server should use.
//
// Someone setting this up has one key and should not have to know about "providers":
//   - "AIza…" keys come from AI Studio and work with the Gemini API.
//   - "AQ.…" keys are Vertex AI keys, tied to a service account in a Google Cloud project.
// Saving a key works out which kind it is, and the server uses whichever key it finds.

import { DEFAULT_PROVIDER, PROVIDERS } from './config.js';
import { macKeychain, readApiKey } from './keychain.js';

export const PROVIDER_LABELS = { vertex: 'Vertex AI', gemini: 'Gemini API (AI Studio)' };

/** "gemini", "vertex", or null when the key is in a format we do not recognise. */
export function detectKeyType(key) {
  if (typeof key !== 'string') return null;
  if (/^AIza[A-Za-z0-9_-]{30,}$/.test(key)) return 'gemini';
  if (/^AQ\.[A-Za-z0-9._-]{20,}$/.test(key)) return 'vertex';
  return null;
}

/**
 * Decide where a key is saved. A type given on the command line wins, but if it disagrees with
 * what the key looks like, the caller gets a warning, because that mix-up ends in a confusing
 * "key rejected" error much later.
 */
export function chooseProviderForKey(key, explicit) {
  if (explicit !== undefined && !PROVIDERS.includes(explicit)) {
    throw new Error(`The key type must be one of: ${PROVIDERS.join(', ')}.`);
  }
  const detected = detectKeyType(key);
  const provider = explicit ?? detected;
  if (!provider) {
    throw new Error(
      'Could not tell what kind of key this is. A Vertex AI key starts with "AQ." and a Gemini API key from AI Studio starts with "AIza".\n' +
        'If you are sure, say which: npm run set-key vertex   or   npm run set-key gemini',
    );
  }
  const warning =
    explicit && detected && explicit !== detected
      ? `This looks like a ${PROVIDER_LABELS[detected]} key, but you asked to save it as a ${PROVIDER_LABELS[explicit]} key. Saved as you asked. If requests fail with "key rejected", run: npm run set-key`
      : null;
  return { provider, detected, warning };
}

/**
 * Pick the provider to use now. In order:
 *   1. DECLTR_PROVIDER, if set, always wins.
 *   2. A key in DECLTR_API_KEY: its format decides.
 *   3. A stored key. If both kinds are stored, Vertex AI is used (set DECLTR_PROVIDER to choose otherwise).
 *   4. Nothing found: the default, so error messages still make sense.
 */
export async function resolveProvider(env = process.env, keychain = macKeychain) {
  if (env.DECLTR_PROVIDER) return { provider: env.DECLTR_PROVIDER, source: 'DECLTR_PROVIDER' };
  if (env.DECLTR_API_KEY) {
    return { provider: detectKeyType(env.DECLTR_API_KEY.trim()) ?? DEFAULT_PROVIDER, source: 'DECLTR_API_KEY' };
  }
  for (const provider of ['vertex', 'gemini']) {
    if (await readApiKey(provider, env, keychain)) return { provider, source: 'stored key' };
  }
  return { provider: DEFAULT_PROVIDER, source: 'default' };
}

/**
 * The server's way of getting its key. While there is no key yet it looks again on every call, so
 * running `npm run set-key` while the server is already up takes effect without a restart, and it
 * follows the kind of key that was saved. Once a key is found it is kept.
 * `config.provider` is updated to match, because the rest of the server reads it from there.
 */
export function createKeySource(config, { env = process.env, keychain = macKeychain } = {}) {
  let cached = null;
  return async function getApiKey() {
    if (cached) return cached;
    const { provider } = await resolveProvider(env, keychain);
    config.provider = provider;
    cached = await readApiKey(provider, env, keychain);
    return cached;
  };
}
