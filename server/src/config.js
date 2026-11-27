// Server configuration. The bind address is deliberately not configurable:
// the server must only ever be reachable from this machine.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 47821;

// Pinned by the "key" field in extension/manifest.json, so it is identical on
// every machine that loads the unpacked extension.
export const DEFAULT_EXTENSION_ID = 'jldfhgcphcbkmjmlkkioebphdaipkcjf';
// The ID Microsoft Edge Add-ons assigned to the store version.
export const EDGE_STORE_EXTENSION_ID = 'ohffgmfbgpkiaapaidcakhpkhllmhopn';
// Accepted unless DECLTR_EXTENSION_ID says otherwise: the unpacked copy and the store versions.
export const DEFAULT_EXTENSION_IDS = [DEFAULT_EXTENSION_ID, EDGE_STORE_EXTENSION_ID];

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// "vertex" bills your Google Cloud project (and its credits) through Vertex AI.
// "gemini" uses the Gemini Developer API (AI Studio, prepaid).
export const PROVIDERS = ['vertex', 'gemini'];
export const DEFAULT_PROVIDER = 'vertex';

/**
 * Where the server keeps its data (the shared sessions), in the usual place for each system.
 * DECLTR_DATA_DIR overrides it, for example for tests or a second copy.
 */
export function dataDirFor(env = process.env, platform = process.platform, home = homedir()) {
  if (env.DECLTR_DATA_DIR) {
    if (!isAbsolute(env.DECLTR_DATA_DIR)) throw new Error('DECLTR_DATA_DIR must be an absolute path');
    return env.DECLTR_DATA_DIR;
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Decltr');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Decltr');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'decltr');
}

export function loadConfig(env = process.env) {
  const port = Number(env.DECLTR_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('DECLTR_PORT must be an integer between 1024 and 65535');
  }

  const ids = (env.DECLTR_EXTENSION_ID ?? DEFAULT_EXTENSION_IDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => /^[a-p]{32}$/.test(id))) {
    throw new Error('DECLTR_EXTENSION_ID must be one or more 32-character Chrome extension IDs');
  }

  const provider = env.DECLTR_PROVIDER ?? DEFAULT_PROVIDER;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`DECLTR_PROVIDER must be one of: ${PROVIDERS.join(', ')}`);
  }

  const model = env.DECLTR_MODEL ?? DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(model)) {
    throw new Error('DECLTR_MODEL contains invalid characters');
  }

  const thinkingBudget = Number(env.DECLTR_THINKING_BUDGET ?? 0);
  if (!Number.isInteger(thinkingBudget) || thinkingBudget < 0 || thinkingBudget > 24576) {
    throw new Error('DECLTR_THINKING_BUDGET must be an integer between 0 and 24576');
  }

  // Set by the background-service definition. Only a server that a service manager will bring back
  // may be asked to restart or stop itself; one started by hand would just disappear.
  const managed = env.DECLTR_MANAGED === '1';

  return {
    host: HOST,
    dataDir: dataDirFor(env),
    managed,
    port,
    provider,
    model,
    thinkingBudget,
    allowedOrigins: new Set(ids.map((id) => `chrome-extension://${id}`)),
  };
}
