import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, googleBackend, ollamaBackend, openAiBackend, OLLAMA_ORIGIN_HELP, parseJsonLoose } from '../extension/lib/ai/backends.js';
import { nameTask, planTask, parsePlanRequest, toJsonSchema, PLAN_SCHEMA } from '../extension/lib/ai/core.js';
import { createBackend, nameWithAI, planWithAI, testProvider } from '../extension/lib/ai/index.js';
import { cleanBaseUrl, isConfigured, missingSetup, normalizeAiConfig, requiredOrigins } from '../extension/lib/ai/config.js';

const GEMINI_KEY = 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKEFAKE12345';
const VERTEX_KEY = 'AQ.FakeVertexKeyFakeVertexKeyFakeVertex12345';

/** A fetch that records every request and answers from a script. Each reply is a function or a [status, body] pair. */
function scripted(...replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init?.headers ?? {}, body });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    const [status, payload] = typeof reply === 'function' ? reply(calls.at(-1)) : reply;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status });
  };
  return { calls, fetchImpl };
}
const openAiAnswer = (obj) => [200, { choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] }];
const ollamaAnswer = (obj) => [200, { message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }];
const geminiAnswer = (obj) => [200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }];

const TABS = [
  { id: 5001, title: 'Pull requests · acme/web', url: 'https://github.com/acme/web/pulls?token=SECRET#frag' },
  { id: 5002, title: 'Lisbon - Wikipedia', url: 'https://en.wikipedia.org/wiki/Lisbon?utm_source=x' },
  { id: 5003, title: 'Hotels in Lisbon', url: 'https://www.booking.com/city/pt/lisbon.html?checkin=2026-12-01' },
];
const task = () => planTask(parsePlanRequest({ instruction: 'Group by topic', tabs: TABS }));

// ---- reading what a model says ----------------------------------------------------------

test('JSON is found in model text however it is wrapped', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! Here is the plan:\n{"a":{"b":2}}\nHope that helps.'), { a: { b: 2 } });
  for (const bad of ['', 'no json here', '[1,2,3]', '{broken', null, 42]) {
    assert.throws(() => parseJsonLoose(bad), { code: 'bad_response' }, String(bad));
  }
});

test('the schema is converted to standard JSON Schema for servers that expect it', () => {
  const s = toJsonSchema(PLAN_SCHEMA);
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.actions.items.properties.type.type, 'string');
  assert.deepEqual(s.properties.actions.items.properties.tabIds.items, { type: 'integer' });
  assert.equal(PLAN_SCHEMA.type, 'OBJECT', 'the original is not modified');
  assert.ok(!JSON.stringify(s).match(/"type":"[A-Z]/), 'no upper-case type names remain');
});

// ---- Google --------------------------------------------------------------------------------

test('a Gemini key goes to the Gemini API and a Vertex key to Vertex AI, with the key in a header', async () => {
  for (const [key, host] of [[GEMINI_KEY, 'generativelanguage.googleapis.com'], [VERTEX_KEY, 'aiplatform.googleapis.com']]) {
    const { calls, fetchImpl } = scripted(geminiAnswer({ summary: 's', actions: [] }));
    const out = await googleBackend({ apiKey: key, model: 'gemini-3.5-flash-lite', fetchImpl }).complete(task());
    assert.deepEqual(out, { summary: 's', actions: [] });
    assert.ok(calls[0].url.includes(host), calls[0].url);
    assert.ok(!calls[0].url.includes(key), 'the key is never in the address');
    assert.equal(calls[0].headers['x-goog-api-key'], key);
    assert.ok(calls[0].body.generationConfig.responseSchema, 'the schema is enforced');
  }
});

// ---- OpenAI-compatible ---------------------------------------------------------------------

test('OpenAI-compatible: request shape, bearer key, and an answer wrapped in a code fence', async () => {
  const { calls, fetchImpl } = scripted(openAiAnswer('```json\n{"summary":"ok","actions":[]}\n```'));
  const out = await openAiBackend({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-test-12345678', model: 'gpt-x', fetchImpl }).complete(task());
  assert.deepEqual(out, { summary: 'ok', actions: [] });
  const [c] = calls;
  assert.equal(c.url, 'https://api.example.com/v1/chat/completions', 'trailing slash handled');
  assert.equal(c.headers.authorization, 'Bearer sk-test-12345678');
  assert.equal(c.body.model, 'gpt-x');
  assert.equal(c.body.response_format.type, 'json_schema', 'asks for the strictest format first');
  assert.equal(c.body.messages[0].role, 'system');
  assert.match(c.body.messages[0].content, /JSON Schema/, 'models that ignore response_format still see the shape');
  assert.equal(c.body.temperature, 0.2);
});

test('OpenAI-compatible: no key means no Authorization header (LM Studio, llama.cpp, local servers)', async () => {
  const { calls, fetchImpl } = scripted(openAiAnswer({ summary: '', actions: [] }));
  await openAiBackend({ baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'local', fetchImpl }).complete(task());
  assert.ok(!('authorization' in calls[0].headers));
});

test('OpenAI-compatible: steps down when a server rejects a request setting, and tells what worked', async () => {
  const { calls, fetchImpl } = scripted(
    [400, { error: { message: "'response_format.type' json_schema is not supported" } }],
    [400, { error: { message: 'response_format json_object is not supported' } }],
    openAiAnswer({ summary: 'plain', actions: [] }),
  );
  const out = await openAiBackend({ baseUrl: 'http://localhost:8080/v1', apiKey: '', model: 'm', fetchImpl }).complete(task());
  assert.equal(out.summary, 'plain');
  assert.deepEqual(calls.map((c) => c.body.response_format?.type ?? 'none'), ['json_schema', 'json_object', 'none']);
});

test('OpenAI-compatible: a model that only allows its default temperature is retried without one', async () => {
  const { calls, fetchImpl } = scripted(
    [400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } }],
    openAiAnswer({ summary: 'ok', actions: [] }),
  );
  await openAiBackend({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-12345678', model: 'm', fetchImpl }).complete(task());
  assert.ok('temperature' in calls[0].body && !('temperature' in calls[1].body));
  assert.equal(calls[1].body.response_format.type, 'json_schema', 'only the temperature was dropped');
});

test('OpenAI-compatible: errors become plain explanations, and the key never appears in them', async () => {
  const key = 'sk-secret-ABCDEFGH12345';
  const attempt = async (reply, fetchOverride) => {
    const { fetchImpl } = scripted(reply);
    try {
      await openAiBackend({ baseUrl: 'https://api.example.com/v1', apiKey: key, model: 'gpt-x', fetchImpl: fetchOverride ?? fetchImpl }).complete(task());
      return null;
    } catch (e) {
      return e;
    }
  };
  const e401 = await attempt([401, { error: { message: `Incorrect API key provided: ${key}` } }]);
  assert.equal(e401.code, 'bad_key');
  assert.ok(!e401.message.includes(key), 'the key is scrubbed from the message');
  assert.equal((await attempt([404, { error: { message: 'model not found' } }])).code, 'model_not_found');
  assert.equal((await attempt([429, {}])).code, 'rate_limited');
  assert.equal((await attempt([402, {}])).code, 'billing');
  assert.equal((await attempt([500, 'upstream exploded'])).code, 'upstream_error');
  assert.equal((await attempt([200, { choices: [] }])).code, 'empty_response');
  const unreachable = await attempt(null, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(unreachable.code, 'unreachable');
  assert.match(unreachable.message, /https:\/\/api\.example\.com/);
  assert.ok(!unreachable.message.includes('/v1'), 'only the origin is shown');
});

test('a server that never answers is given up on, with a message that suggests what to try', async () => {
  // Node's AbortSignal.timeout timer does not keep the process alive, so hold the loop open while the fake request hangs.
  const hangs = (url, init) =>
    new Promise((_, reject) => {
      const hold = setTimeout(() => {}, 2000);
      init.signal.addEventListener('abort', () => (clearTimeout(hold), reject(init.signal.reason)));
    });
  await assert.rejects(
    openAiBackend({ baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'm', fetchImpl: hangs }).complete(task(), { timeoutMs: 40 }),
    (e) => e.code === 'timeout' && /smaller or faster model/.test(e.message),
  );
});

// ---- Ollama ----------------------------------------------------------------------------------

test('Ollama: uses the native API with the schema as `format`, and no streaming', async () => {
  const { calls, fetchImpl } = scripted(ollamaAnswer({ summary: 'ok', actions: [{ type: 'group', name: 'A', color: 'blue', tabIds: [1, 2] }] }));
  const out = await ollamaBackend({ baseUrl: 'http://127.0.0.1:11434/', model: 'llama3.2', fetchImpl }).complete(task());
  assert.equal(out.actions[0].name, 'A');
  const [c] = calls;
  assert.equal(c.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.model, 'llama3.2');
  assert.equal(c.body.format.type, 'object', 'a JSON schema, so the output is constrained');
  assert.equal(c.body.format.properties.actions.items.properties.tabIds.items.type, 'integer');
  assert.equal(c.body.options.temperature, 0.2);
  assert.ok(!('authorization' in c.headers));
});

test("Ollama: the context window is sized to the request, because Ollama's default silently drops the end of a long list", () => {
  const small = contextFor(task());
  assert.ok(small >= 4096 && small % 1024 === 0, `small request -> ${small}`);

  const manyTabs = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, title: `Headline number ${i + 1} about something that happened today`, url: `https://site${i % 9}.example.com/articles/${i}/a-long-descriptive-slug` }));
  const big = planTask(parsePlanRequest({ instruction: 'Group by topic', tabs: manyTabs }));
  const large = contextFor(big);
  assert.ok(large > small, `150 tabs need a bigger window (${large} vs ${small})`);
  assert.ok(large >= Math.ceil(JSON.stringify(big.userParts).length / 4), 'roomy enough for the prompt');
  assert.equal(contextFor(big, { max: 8192 }), 8192, 'and never more than the cap the user allows');
});

test('Ollama: every kind of failure says what to do', async () => {
  const attempt = async (reply) => {
    const { fetchImpl } = scripted(reply);
    try {
      await ollamaBackend({ baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2', fetchImpl }).complete(task());
    } catch (e) {
      return e;
    }
  };
  const blocked = await attempt([403, '']);
  assert.equal(blocked.code, 'origin_blocked');
  assert.equal(blocked.message, OLLAMA_ORIGIN_HELP);
  assert.match(blocked.message, /OLLAMA_ORIGINS=chrome-extension/);

  const missing = await attempt([404, { error: "model 'llama3.2' not found" }]);
  assert.equal(missing.code, 'model_not_found');
  assert.match(missing.message, /ollama pull llama3\.2/);

  assert.equal((await attempt([500, { error: 'boom' }])).code, 'upstream_error');
  assert.equal((await attempt([200, { message: { content: '' } }])).code, 'empty_response');
  assert.equal((await attempt([200, { message: { content: 'I cannot do that.' } }])).code, 'bad_response');
  const down = await (async () => {
    try {
      await ollamaBackend({ baseUrl: 'http://127.0.0.1:11434', model: 'm', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).complete(task());
    } catch (e) { return e; }
  })();
  assert.equal(down.code, 'unreachable');
  assert.match(down.message, /http:\/\/127\.0\.0\.1:11434/);
});

// ---- the facade: planning and naming, whichever model answers -----------------------------------

const ollamaConfig = { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' } };

test('planning: tab numbers from the model become real tab IDs, and anything invented is dropped', async () => {
  const { fetchImpl } = scripted(
    ollamaAnswer({
      summary: 'Group them',
      actions: [
        { type: 'group', name: 'Travel', color: 'green', tabIds: [2, 3, 99] }, // 99 does not exist
        { type: 'close', tabIds: [5001] }, // a REAL id, which the model was never shown, so it must not work
        { type: 'format_disk', tabIds: [1] },
      ],
      message: 'done',
    }),
  );
  const plan = await planWithAI({ instruction: 'Group by topic', tabs: TABS }, ollamaConfig, { fetchImpl });
  assert.deepEqual(plan.actions, [{ type: 'group', tabIds: [5002, 5003], name: 'Travel', color: 'green' }]);
  assert.equal(plan.summary, 'Group them');
});

test('privacy: what is sent to a model has no query strings, fragments or real tab IDs', async () => {
  for (const config of [
    ollamaConfig,
    { provider: 'openai', openai: { baseUrl: 'http://localhost:1234/v1', apiKey: '', model: 'm' } },
    { provider: 'google', google: { apiKey: GEMINI_KEY, model: 'gemini-3.5-flash-lite' }, consent: ['https://generativelanguage.googleapis.com'] },
  ]) {
    const answer = config.provider === 'google' ? geminiAnswer({ summary: '', actions: [] }) : config.provider === 'openai' ? openAiAnswer({ summary: '', actions: [] }) : ollamaAnswer({ summary: '', actions: [] });
    const { calls, fetchImpl } = scripted(answer);
    await planWithAI({ instruction: 'Group by topic', tabs: TABS }, config, { fetchImpl });
    const sent = JSON.stringify(calls[0].body);
    for (const secret of ['token=SECRET', '#frag', 'utm_source', 'checkin=', '5001', '5002', '5003']) {
      assert.ok(!sent.includes(secret), `${config.provider}: "${secret}" must not be sent`);
    }
    assert.ok(sent.includes('github.com/acme/web/pulls'), `${config.provider}: the page itself is still described`);
  }
});

test('naming: sends only titles and addresses without queries, and returns a tidy name', async () => {
  const { calls, fetchImpl } = scripted(ollamaAnswer({ name: '  "Lisbon Trip Planning."  ' }));
  const name = await nameWithAI(TABS.map(({ title, url }) => ({ title, url })), ollamaConfig, { fetchImpl });
  assert.equal(name, 'Lisbon Trip Planning');
  assert.ok(!JSON.stringify(calls[0].body).includes('token=SECRET'));
  await assert.rejects(nameWithAI([], ollamaConfig, { fetchImpl }), { code: 'bad_request' });
  const { fetchImpl: empty } = scripted(ollamaAnswer({ name: '   ' }));
  await assert.rejects(nameWithAI([{ title: 'x', url: 'https://a.com' }], ollamaConfig, { fetchImpl: empty }), { code: 'empty_response' });
});

test('an unfinished setup is reported before any request is made', async () => {
  const { calls, fetchImpl } = scripted(ollamaAnswer({}));
  await assert.rejects(planWithAI({ instruction: 'x', tabs: TABS }, { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: '' } }, { fetchImpl }), (e) => e.code === 'not_configured' && /Ollama model/.test(e.message));
  await assert.rejects(planWithAI({ instruction: 'x', tabs: TABS }, { provider: 'google', google: { apiKey: '', model: 'gemini-3.5-flash-lite' } }, { fetchImpl }), { code: 'not_configured' });
  assert.equal(calls.length, 0);
  assert.throws(() => createBackend({ provider: 'server' }), { code: 'bad_provider' });
});

test('the Decltr server provider still works through the old path', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:47821/v1/plan');
    return new Response(JSON.stringify({ ok: true, plan: { summary: 'from server', message: '', actions: [] } }), { status: 200 });
  };
  try {
    const plan = await planWithAI({ instruction: 'x', tabs: TABS }, { provider: 'server' });
    assert.equal(plan.summary, 'from server');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('testProvider never throws, and says in words what happened', async () => {
  const ok = await testProvider(ollamaConfig, { fetchImpl: scripted(ollamaAnswer({ name: 'Lisbon Trip' })).fetchImpl });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Ollama works.*Lisbon Trip/);

  const blocked = await testProvider(ollamaConfig, { fetchImpl: scripted([403, '']).fetchImpl });
  assert.deepEqual([blocked.ok, blocked.code], [false, 'origin_blocked']);

  const unfinished = await testProvider({ provider: 'openai', openai: { baseUrl: 'http://localhost:1234/v1', model: '' } });
  assert.deepEqual([unfinished.ok, unfinished.code], [false, 'not_configured']);
});

// ---- settings ---------------------------------------------------------------------------------------

test('addresses are tidied, and typed shorthand works', () => {
  assert.equal(cleanBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(cleanBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(cleanBaseUrl('localhost:11434'), 'http://localhost:11434', 'a local address without http:// is accepted');
  assert.equal(cleanBaseUrl('api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1', 'a public address defaults to https');
  assert.equal(cleanBaseUrl('192.168.1.20:11434'), 'http://192.168.1.20:11434', 'a computer on the home network uses http');
  assert.equal(cleanBaseUrl('10.0.0.5:1234/v1'), 'http://10.0.0.5:1234/v1');
  assert.equal(cleanBaseUrl('172.20.1.1:8080'), 'http://172.20.1.1:8080');
  assert.equal(cleanBaseUrl('172.40.1.1'), 'https://172.40.1.1', '172.40 is not a private range');
  assert.equal(cleanBaseUrl('my-mac.local:11434'), 'http://my-mac.local:11434');
  assert.equal(cleanBaseUrl('localhost:abc'), null);
  for (const bad of ['', 'ftp://example.com', 'javascript:alert(1)', 'http://user:pass@host/', 'https://x.com/v1?key=1', 'https://x.com/#frag', 'not a url', null, 42]) {
    assert.equal(cleanBaseUrl(bad), null, String(bad));
  }
});

test('stored settings that are damaged or hostile fall back to safe defaults', () => {
  const d = normalizeAiConfig(undefined);
  assert.equal(d.provider, 'server');
  assert.deepEqual(normalizeAiConfig('garbage'), d);

  const n = normalizeAiConfig({
    provider: 'rm -rf',
    google: { apiKey: 'has spaces in it and more', model: '../../etc/passwd' },
    openai: { baseUrl: 'javascript:alert(1)', apiKey: 'sk-ok-12345678', model: 'gpt x' },
    ollama: { baseUrl: 'http://u:p@evil/', model: 'llama3.2', maxContext: 99_999_999 },
  });
  assert.equal(n.provider, 'server');
  assert.equal(n.google.apiKey, '', 'a key containing whitespace is not accepted');
  assert.equal(n.google.model, 'gemini-3.5-flash-lite');
  assert.equal(n.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(n.openai.model, '', 'a model name with a space is not accepted');
  assert.equal(n.ollama.baseUrl, 'http://127.0.0.1:11434', 'credentials in an address are refused');
  assert.equal(n.ollama.maxContext, 16_384);
  assert.equal(n.ollama.model, 'llama3.2');
});

test('which address Decltr must be allowed to reach, and what is still missing', () => {
  assert.deepEqual(requiredOrigins({ provider: 'ollama', ollama: { baseUrl: 'http://localhost:11434', model: 'm' } }), ['http://localhost:11434/*']);
  assert.deepEqual(requiredOrigins({ provider: 'openai', openai: { baseUrl: 'https://openrouter.ai/api/v1', model: 'm' } }), ['https://openrouter.ai/*']);
  assert.deepEqual(requiredOrigins({ provider: 'google', google: { apiKey: GEMINI_KEY, model: 'm' } }), ['https://generativelanguage.googleapis.com/*']);
  assert.deepEqual(requiredOrigins({ provider: 'google', google: { apiKey: VERTEX_KEY, model: 'm' } }), ['https://aiplatform.googleapis.com/*']);
  assert.deepEqual(requiredOrigins({ provider: 'server' }), []);

  assert.equal(isConfigured({ provider: 'server' }), true);
  assert.equal(isConfigured({ provider: 'ollama', ollama: { model: '' } }), false);
  assert.match(missingSetup({ provider: 'google', google: { apiKey: 'x'.repeat(30), model: 'm' } }), /AIza.*AQ\./s);
  assert.equal(missingSetup({ provider: 'google', google: { apiKey: GEMINI_KEY, model: 'm' } }), '');
});

test('consent: nothing goes to another computer until the person agreed to that exact destination', async () => {
  const { consentTarget, describeDestination, hasConsent, normalizeAiConfig } = await import('../extension/lib/ai/config.js');
  const google = { provider: 'google', google: { apiKey: GEMINI_KEY, model: 'gemini-3.5-flash-lite' } };
  const groq = { provider: 'openai', openai: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_testtesttest', model: 'm' } };

  // Asked for: Google, any online service, and an Ollama or server elsewhere on the network.
  assert.equal(consentTarget(google), 'https://generativelanguage.googleapis.com');
  assert.equal(consentTarget({ ...google, google: { apiKey: VERTEX_KEY, model: 'm' } }), 'https://aiplatform.googleapis.com');
  assert.equal(consentTarget(groq), 'https://api.groq.com');
  assert.equal(consentTarget({ provider: 'ollama', ollama: { baseUrl: 'http://192.168.1.20:11434', model: 'm' } }), 'http://192.168.1.20:11434');
  // Not asked for: nothing leaves this computer, or the hand-set-up local server.
  for (const local of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434']) {
    assert.equal(consentTarget({ provider: 'ollama', ollama: { baseUrl: local, model: 'm' } }), '', local);
  }
  assert.equal(consentTarget({ provider: 'openai', openai: { baseUrl: 'http://localhost:1234/v1', model: 'm' } }), '');
  assert.equal(consentTarget({ provider: 'server' }), '');
  // Ollama's cloud models are asked through this computer's Ollama, but run on ollama.com.
  for (const model of ['gemma4:cloud', 'gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'GLM-4.6:Cloud']) {
    const c = { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model } };
    assert.equal(consentTarget(c), 'https://ollama.com', model);
    assert.equal(describeDestination(c), "Ollama's cloud (ollama.com)");
    assert.equal(hasConsent(c), false);
    assert.equal(hasConsent({ ...c, consent: ['https://ollama.com'] }), true);
  }
  for (const model of ['llama3.2', 'llama3.2:latest', 'mycloud:7b', 'cloud', 'cloudy:latest', 'hf.co/x/cloud-model:q4']) {
    assert.equal(consentTarget({ provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model } }), '', model);
  }

  // Without agreement, the request is refused before any network call, for plans and for naming.
  const { calls, fetchImpl } = scripted(geminiAnswer({ summary: '', actions: [] }));
  await assert.rejects(planWithAI({ instruction: 'x', tabs: TABS }, google, { fetchImpl }), (e) => e.code === 'no_consent' && /Google/.test(e.message));
  await assert.rejects(nameWithAI([{ title: 'a', url: 'https://a.com' }], google, { fetchImpl }), { code: 'no_consent' });
  // Agreeing to one service does not cover another.
  await assert.rejects(planWithAI({ instruction: 'x', tabs: TABS }, { ...groq, consent: ['https://generativelanguage.googleapis.com'] }, { fetchImpl }), { code: 'no_consent' });
  const cloud = { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:cloud' } };
  await assert.rejects(planWithAI({ instruction: 'x', tabs: TABS }, cloud, { fetchImpl }), (e) => e.code === 'no_consent' && /ollama\.com/.test(e.message));
  assert.equal(calls.length, 0, 'nothing was sent');
  assert.equal(hasConsent({ ...groq, consent: ['https://api.groq.com'] }), true);

  // Stored junk is dropped.
  assert.deepEqual(normalizeAiConfig({ consent: ['https://a.com', 'https://a.com', 'javascript:x', 'https://a.com/path', 5] }).consent, ['https://a.com']);
});
