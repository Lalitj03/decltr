#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { createApp, VERSION } from '../src/app.js';
import { isValidKeyFormat, readApiKey, storeApiKey } from '../src/keychain.js';
import { chooseProviderForKey, createKeySource, PROVIDER_LABELS } from '../src/provider.js';

const command = process.argv[2] ?? 'start';

try {
  if (command === 'start') await start();
  else if (command === 'set-key') await setKey();
  else if (command === 'status') await status();
  else usage(command === 'help' || command === '--help' ? 0 : 1);
} catch (err) {
  console.error(`decltr-server: ${err.message}`);
  process.exit(1);
}

function usage(code) {
  console.log(`Decltr companion server ${VERSION}

Usage: decltr-server <command>

  start     Run the server (default). Listens on 127.0.0.1 only.
  set-key [provider]   Store an API key in the macOS Keychain (vertex or gemini).
  status    Show whether a key is configured and the server is running.
`);
  process.exit(code);
}

async function start() {
  const config = loadConfig();
  // Finds the API key and, from it, which Google API to call. Until a key exists it looks again on every
  // request, so running set-key while the server is up needs no restart.
  const getApiKey = createKeySource(config);

  // Exit codes are how the background service tells a deliberate stop from a failure: it brings the
  // server back after a non-zero exit (a crash, or a restart request) and leaves it stopped after 0.
  const EXIT_RESTART = 75;
  function shutdown(code) {
    // Idle keep-alive connections would keep server.close() waiting for seconds. Drop them so restarts are quick.
    setTimeout(() => process.exit(code), 2000).unref();
    server.close(() => process.exit(code));
    server.closeAllConnections?.();
  }

  const server = createApp({
    config,
    getApiKey,
    control: { restart: () => shutdown(EXIT_RESTART), stop: () => shutdown(0) },
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`decltr-server: port ${config.port} is already in use. Is Decltr already running?`);
    } else {
      console.error(`decltr-server: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, async () => {
    const hasKey = Boolean(await getApiKey());
    console.log(`Decltr server ${VERSION} listening on http://${config.host}:${config.port}`);
    console.log(`Provider: ${config.provider}, model: ${config.model}`);
    console.log(`Allowed origins: ${[...config.allowedOrigins].join(', ')}`);
    console.log(hasKey ? 'API key: found' : 'API key: NOT FOUND. Run "npm run set-key".');
    if (config.managed) console.log('Running as a background service: the panel can restart or stop it.');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
}

async function setKey() {
  const explicit = process.argv[3]; // optional: "vertex" or "gemini"
  const input = process.stdin.isTTY ? await promptHidden('Paste your API key (input is hidden): ') : await readAll(process.stdin);
  const key = input.trim();
  if (!isValidKeyFormat(key)) throw new Error('That does not look like an API key.');

  const { provider, warning } = chooseProviderForKey(key, explicit);
  await storeApiKey(provider, key);
  if (warning) console.log(`Warning: ${warning}`);
  console.log(`Saved your ${PROVIDER_LABELS[provider]} key to the macOS Keychain.`);
  console.log('A server that is already running with a key needs a restart to use this one: npm run server:restart');

  // When both kinds are saved, Vertex AI is used. Only worth mentioning if that is not the one just saved.
  if (provider === 'gemini' && (await readApiKey('vertex'))) {
    console.log(`Note: you also have a ${PROVIDER_LABELS.vertex} key saved, and that one is used when both exist. To use this Gemini key instead, set DECLTR_PROVIDER=gemini (for the background service: DECLTR_PROVIDER=gemini npm run server:install).`);
  }
}

async function status() {
  const config = loadConfig();
  const hasKey = Boolean(await createKeySource(config)()); // also settles which provider applies
  console.log(`Provider: ${PROVIDER_LABELS[config.provider]}`);
  console.log(`API key: ${hasKey ? 'found' : 'missing'}`);
  try {
    const res = await fetch(`http://${config.host}:${config.port}/v1/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: [...config.allowedOrigins][0] },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json();
    console.log(`Server: running (v${body.version}, model ${body.model})`);
  } catch {
    console.log('Server: not running');
  }
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => (data += c));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
