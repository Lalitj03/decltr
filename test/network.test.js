import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import { hasAccess, OLLAMA_FRIENDLY_ORIGIN, requestAccess, syncOriginRule } from '../extension/lib/ai/network.js';
import { listOllamaModels, OLLAMA_ORIGIN_HELP } from '../extension/lib/ai/backends.js';
import { AI_KEY, loadAiConfig, saveAiConfig } from '../extension/lib/ai/config.js';

const OLLAMA = { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' } };
const install = () => (globalThis.chrome = createMockChrome({ tabs: [] }));

test('only the chosen address is ever asked for, and nothing is asked for when none is needed', async () => {
  const c = install();
  assert.equal(await hasAccess({ provider: 'server' }), true, 'the server path needs nothing');
  assert.equal(await hasAccess(OLLAMA), false);

  assert.equal(await requestAccess(OLLAMA), true);
  assert.deepEqual(c.permissions.__asked, [['http://127.0.0.1:11434/*']], 'exactly one address, not "all sites"');
  assert.equal(await hasAccess(OLLAMA), true);

  await requestAccess(OLLAMA);
  assert.equal(c.permissions.__asked.length, 1, 'no second prompt for something already allowed');
  await requestAccess({ provider: 'server' });
  assert.equal(c.permissions.__asked.length, 1);
});

test('declining the permission prompt is handled, not an error', async () => {
  const c = install();
  c.permissions.__answer = false;
  assert.equal(await requestAccess(OLLAMA), false);
  assert.equal(await hasAccess(OLLAMA), false);
  c.permissions.request = async () => { throw new Error('This function must be called during a user gesture'); };
  assert.equal(await requestAccess(OLLAMA), false, 'Chrome refusing outside a click is reported as "not granted"');
});

test('the Origin rule exists only while Ollama is chosen, and only for its address', async () => {
  const c = install();
  assert.equal(await syncOriginRule(OLLAMA), true);
  const [rule, ...others] = await c.declarativeNetRequest.getDynamicRules();
  assert.equal(others.length, 0);
  assert.deepEqual(rule.action.requestHeaders, [{ header: 'Origin', operation: 'set', value: OLLAMA_FRIENDLY_ORIGIN }]);
  assert.equal(rule.condition.urlFilter, '|http://127.0.0.1:11434/', 'one address, not every site');
  assert.deepEqual(rule.condition.initiatorDomains, ['testextensionid'], 'only requests this extension makes');
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);

  // Changing the address moves the rule rather than adding a second one.
  await syncOriginRule({ provider: 'ollama', ollama: { baseUrl: 'http://192.168.1.20:11434', model: 'm' } });
  const moved = await c.declarativeNetRequest.getDynamicRules();
  assert.equal(moved.length, 1);
  assert.equal(moved[0].condition.urlFilter, '|http://192.168.1.20:11434/');

  // Choosing anything else removes it, so the extension never rewrites headers it has no reason to.
  for (const other of [{ provider: 'google' }, { provider: 'openai' }, { provider: 'server' }]) {
    await syncOriginRule(OLLAMA);
    assert.equal(await syncOriginRule(other), false);
    assert.equal((await c.declarativeNetRequest.getDynamicRules()).length, 0, `${other.provider}: rule removed`);
  }
});

test('a browser without the rules API is tolerated', async () => {
  const c = install();
  delete c.declarativeNetRequest;
  assert.equal(await syncOriginRule(OLLAMA), false);
});

test('settings are saved and loaded through the same cleaning as everything else', async () => {
  install();
  await saveAiConfig({ ...OLLAMA, ollama: { ...OLLAMA.ollama, baseUrl: 'localhost:11434/' } });
  const stored = (await chrome.storage.local.get(AI_KEY))[AI_KEY];
  assert.equal(stored.ollama.baseUrl, 'http://localhost:11434', 'shorthand tidied on the way in');
  assert.equal((await loadAiConfig()).provider, 'ollama');

  await chrome.storage.local.set({ [AI_KEY]: { provider: 'ollama', ollama: { baseUrl: 'javascript:alert(1)', model: '../x' } } });
  const cleaned = await loadAiConfig();
  assert.equal(cleaned.ollama.baseUrl, 'http://127.0.0.1:11434', 'a tampered value cannot reach the network code');
  assert.equal(cleaned.ollama.model, '');
});

test('the list of downloaded Ollama models is read, sorted, and failures explain themselves', async () => {
  const reply = (status, body) => async (url) => (assert.equal(String(url), 'http://127.0.0.1:11434/api/tags'), new Response(JSON.stringify(body), { status }));
  assert.deepEqual(await listOllamaModels('http://127.0.0.1:11434/', { fetchImpl: reply(200, { models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }, { nope: 1 }, { name: '' }] }) }), ['llama3.2:latest', 'qwen3:8b']);
  assert.deepEqual(await listOllamaModels('http://127.0.0.1:11434', { fetchImpl: reply(200, {}) }), [], 'nothing downloaded yet');
  await assert.rejects(listOllamaModels('http://127.0.0.1:11434', { fetchImpl: reply(403, '') }), (e) => e.code === 'origin_blocked' && e.message === OLLAMA_ORIGIN_HELP);
  await assert.rejects(listOllamaModels('http://127.0.0.1:11434', { fetchImpl: reply(500, {}) }), { code: 'upstream_error' });
  await assert.rejects(listOllamaModels('http://127.0.0.1:11434', { fetchImpl: async () => { throw new TypeError('x'); } }), { code: 'unreachable' });
});
