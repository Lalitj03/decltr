// A stand-in for a local model server, for testing without installing one.
//   /api/chat            Ollama's API
//   /v1/chat/completions OpenAI's API (requires "Authorization: Bearer test-key" when --key is given)
//
// It rejects browser extensions the way Ollama does: a request carrying an Origin that is not this machine
// gets HTTP 403, unless that origin is listed in OLLAMA_ORIGINS. Requests with no Origin (curl, Node) pass.
//
//   node dev/fake-model-server.mjs [--port 11999] [--key] [--open]
//   --open  accept any origin, like OpenAI, OpenRouter, LM Studio and most other OpenAI-compatible servers
import http from 'node:http';

const arg = (name) => process.argv.includes(`--${name}`);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 11999;
const requireKey = arg('key');
const openOrigins = arg('open');
const allowed = (process.env.OLLAMA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin || openOrigins) return true;
  try {
    const u = new URL(origin);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return true;
  } catch { /* not a URL */ }
  return allowed.some((rule) => rule === '*' || rule === origin || (rule.endsWith('*') && origin.startsWith(rule.slice(0, -1))));
}

const log = [];
const answerFor = (schema) => {
  const props = schema?.properties ?? {};
  if ('name' in props && !('actions' in props)) return { name: 'Lisbon Trip Planning' };
  return { summary: 'Grouped by topic.', message: '', actions: [{ type: 'group', name: 'Travel', color: 'green', tabIds: [1, 2] }] };
};

http.createServer((req, res) => {
  const origin = req.headers.origin;
  const entry = { method: req.method, url: req.url, origin: origin ?? '(none)', status: 0 };
  log.push(entry);
  const send = (status, body, headers = {}) => {
    entry.status = status;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (!originAllowed(origin)) return send(403, '');
  const cors = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' } : {};
  if (req.method === 'OPTIONS') return send(204, '', cors);
  if (req.url === '/__log') return send(200, log, cors);
  if (req.url === '/api/version') return send(200, { version: '0.0.0-fake' }, cors);

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }, cors); }
    if (req.url === '/api/chat') {
      if (!json.model) return send(400, { error: 'model is required' }, cors);
      entry.detail = { model: json.model, num_ctx: json.options?.num_ctx, hasFormat: Boolean(json.format) };
      return send(200, { model: json.model, message: { role: 'assistant', content: JSON.stringify(answerFor(json.format)) }, done: true }, cors);
    }
    if (req.url === '/v1/chat/completions') {
      if (requireKey && req.headers.authorization !== 'Bearer test-key') return send(401, { error: { message: 'Incorrect API key provided: ' + (req.headers.authorization ?? '').slice(7) } }, cors);
      const schema = json.response_format?.json_schema?.schema;
      entry.detail = { model: json.model, format: json.response_format?.type };
      return send(200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(answerFor(schema)) } }] }, cors);
    }
    send(404, { error: 'not found' }, cors);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake model server on http://127.0.0.1:${port} (key required: ${requireKey}, allowed origins: ${allowed.join(', ') || 'none beyond localhost'})`));
