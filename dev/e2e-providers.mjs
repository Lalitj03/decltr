// End-to-end check of the model providers inside real Chrome, with the real Decltr extension loaded.
// It talks to stand-in model servers (dev/fake-model-server.mjs) so it needs no model and no key.
//
//   node dev/e2e-providers.mjs
//
// A separate Chrome with a throwaway profile is used. Nothing of yours is touched.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from './builtin-ai-lab/cdp-pipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spawnServer = (port, ...args) => spawn('node', [join(here, 'fake-model-server.mjs'), '--port', String(port), ...args], { stdio: 'ignore' });

const OLLAMA = 11999; // rejects extension origins, like the real thing
const OPENAI = 11998; // wants "Authorization: Bearer test-key"
const servers = [spawnServer(OLLAMA), spawnServer(OPENAI, '--key', '--open')];
await sleep(900);

const browser = launchChromePipe({ profileDir: mkdtempSync(join(tmpdir(), 'decltr-e2e-')) });
await sleep(3000);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

try {
  // The real extension asks the user to allow each address, using a Chrome prompt that cannot be clicked from here.
  // Load a copy whose manifest already allows the test addresses; everything else is the extension as shipped.
  const copy = join(mkdtempSync(join(tmpdir(), 'decltr-ext-')), 'extension');
  cpSync(join(here, '..', 'extension'), copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*', 'http://localhost/*');
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  const id = await browser.loadExtension(copy);
  const page = await browser.openPage(`chrome-extension://${id}/sidepanel.html`);
  await sleep(1500);
  const ev = (expr, opts) => page.evaluate(expr, opts);
  const log = async (port) => (await (await fetch(`http://127.0.0.1:${port}/__log`)).json()).filter((e) => e.url !== '/__log');

  // Grant the addresses the way a click on "Allow" would. In an automated browser the permission prompt cannot be
  // clicked, so give the extension the same access directly through its own settings.
  await ev(`(async () => { const { saveAiConfig } = await import('./lib/ai/config.js'); window.__save = saveAiConfig; return true; })()`);

  const tabs = JSON.stringify([
    { id: 11, title: 'Flights to Lisbon', url: 'https://www.google.com/travel/flights?utm_source=x' },
    { id: 12, title: 'Hotels in Lisbon', url: 'https://www.booking.com/city/pt/lisbon.html#top' },
    { id: 13, title: 'Pull requests', url: 'https://github.com/acme/web/pulls' },
  ]);
  const plan = (config) => ev(`(async () => {
    const { planWithAI } = await import('./lib/ai/index.js');
    try { const p = await planWithAI({ instruction: 'Group by topic', tabs: ${tabs} }, ${JSON.stringify(config)}); return { ok: true, actions: p.actions, summary: p.summary }; }
    catch (e) { return { ok: false, code: e.code, message: e.message }; }
  })()`);
  const nameIt = (config) => ev(`(async () => {
    const { nameWithAI } = await import('./lib/ai/index.js');
    try { return { ok: true, name: await nameWithAI(${tabs}, ${JSON.stringify(config)}) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
  })()`);

  // ---- 1. Ollama without the fix: refused, with instructions ----
  const ollama = { provider: 'ollama', ollama: { baseUrl: `http://127.0.0.1:${OLLAMA}`, model: 'llama3.2' } };
  await ev(`chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1001] })`);
  const blocked = await plan(ollama);
  check('Ollama, no Origin rule: refused with a clear fix', !blocked.ok && blocked.code === 'origin_blocked' && /OLLAMA_ORIGINS/.test(blocked.message), JSON.stringify(blocked).slice(0, 120));

  // ---- 2. Ollama with the extension's own rule: works, with no configuration on the Ollama side ----
  await ev(`(async () => { const { syncOriginRule } = await import('./lib/ai/network.js'); return syncOriginRule(${JSON.stringify(ollama)}); })()`);
  const planned = await plan(ollama);
  check('Ollama, with the Origin rule: a plan comes back with real tab IDs', planned.ok && planned.actions?.[0]?.type === 'group' && JSON.stringify(planned.actions[0].tabIds) === '[11,12]', JSON.stringify(planned).slice(0, 160));
  const named = await nameIt(ollama);
  check('Ollama: naming works', named.ok && named.name === 'Lisbon Trip Planning', JSON.stringify(named));

  const seen = (await log(OLLAMA)).filter((e) => e.url === '/api/chat');
  const accepted = seen.filter((e) => e.status === 200);
  check('what Ollama received: the rewritten Origin, a schema, and a context window', accepted.length >= 2 && accepted.every((e) => e.origin === 'http://127.0.0.1' && e.detail?.hasFormat && e.detail.num_ctx >= 4096), JSON.stringify(accepted.map((e) => [e.origin, e.detail])));

  // ---- 3. The rule is limited to Ollama's address ----
  await ev(`fetch('http://127.0.0.1:${OPENAI}/probe', { method: 'POST', body: '{}' }).then((r) => r.status)`);
  const probe = (await log(OPENAI)).filter((e) => e.url === '/probe').pop();
  check('the Origin rule does not apply to any other address', !!probe && probe.origin.startsWith('chrome-extension://'), JSON.stringify(probe));
  // ---- 4. Switching away removes the rule ----
  await ev(`(async () => { const { syncOriginRule } = await import('./lib/ai/network.js'); return syncOriginRule({ provider: 'openai' }); })()`);
  const rules = await ev('chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)');
  check('choosing another model removes the Origin rule', rules === 0, `${rules} rules left`);

  // ---- 5. OpenAI-compatible with a key ----
  const openai = (key) => ({ provider: 'openai', openai: { baseUrl: `http://127.0.0.1:${OPENAI}/v1`, apiKey: key, model: 'gpt-x' } });
  const goodKey = await plan(openai('test-key'));
  check('OpenAI-compatible server with the right key: a plan comes back with real tab IDs', goodKey.ok && JSON.stringify(goodKey.actions?.[0]?.tabIds) === '[11,12]', JSON.stringify(goodKey).slice(0, 200));
  const sentToOpenAi = (await log(OPENAI)).filter((e) => e.url === '/v1/chat/completions' && e.status === 200);
  check('it asked for a JSON schema first, and no Origin rewriting was involved', sentToOpenAi.length >= 1 && sentToOpenAi[0].detail?.format === 'json_schema' && sentToOpenAi[0].origin.startsWith('chrome-extension://'), JSON.stringify(sentToOpenAi.map((e) => [e.origin.slice(0, 22), e.detail])));

  // ---- 6. A wrong key is reported as such, and the key never appears in the message ----
  const wrong = await plan(openai('wrong-key-12345'));
  check('wrong key: reported as a key problem, and the key is not repeated', !wrong.ok && wrong.code === 'bad_key' && !wrong.message.includes('wrong-key-12345'), JSON.stringify(wrong).slice(0, 200));

  // ---- 7. The settings page in the real panel ----
  await ev(`(async () => { const { saveAiConfig } = await import('./lib/ai/config.js'); await saveAiConfig({ provider: 'ollama', ollama: { baseUrl: 'localhost:${OLLAMA}', model: '' } }); })()`);
  await page.evaluate('location.reload()');
  await sleep(1800);
  const ui = await ev(`(() => ({
    provider: document.getElementById('aiProvider').value,
    ollamaFieldsShown: !document.getElementById('aiFields-ollama').hidden,
    googleFieldsHidden: document.getElementById('aiFields-google').hidden,
    address: document.getElementById('ollamaUrl').value,
    pill: document.getElementById('statusText').innerText,
    serverBoxHidden: document.getElementById('serverBox').hidden,
    cards: [...document.querySelectorAll('[data-setup] h3')].map((h) => h.innerText),
  }))()`);
  check('the panel loads the saved model and shows the right fields', ui.provider === 'ollama' && ui.ollamaFieldsShown && ui.googleFieldsHidden && ui.address === `http://localhost:${OLLAMA}`, JSON.stringify(ui));
  check('an unfinished Ollama setup says "Set up AI" and offers the choices', ui.pill === 'Set up AI' && ui.cards.some((t) => /Choose how Decltr should think/.test(t)) && ui.serverBoxHidden, JSON.stringify({ pill: ui.pill, cards: ui.cards, serverBoxHidden: ui.serverBoxHidden }));
} catch (err) {
  check('the test ran to the end', false, err.message);
} finally {
  browser.child.kill();
  servers.forEach((s) => s.kill());
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
