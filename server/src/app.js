import http from 'node:http';
import { authorize, RateLimiter, redact } from './security.js';
import {
  buildGeminiBody, buildNameBody, normalizeName, normalizePlan, parseNameRequest, parsePlanRequest, RequestError,
} from '../../extension/lib/ai/core.js';
import { callGemini, UpstreamError } from '../../extension/lib/ai/gemini.js';

const MAX_BODY_BYTES = 512 * 1024;
export const VERSION = '0.3.0';
// What this server can do. The extension compares this with what it needs, so an old server that
// is still running after an update shows up as "Restart server" instead of failing with a vague error.
export const FEATURES = ['plan', 'name', 'control'];

/**
 * Build the HTTP server. Dependencies are injected so tests never touch the
 * network or the Keychain.
 */
/**
 * `control` is how the process is asked to restart or stop: { restart(), stop() }. Injected so tests never exit the process.
 */
export function createApp({ config, getApiKey, callModel = callGemini, control = { restart() {}, stop() {} }, log = () => {} }) {
  const limiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
  let inFlight = 0;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    res.on('finish', () => log(`${route} ${res.statusCode} ${Date.now() - started}ms`));

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      const auth = authorize(req, config);
      if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message);

      res.setHeader('Access-Control-Allow-Origin', auth.origin);
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
        res.setHeader('Access-Control-Max-Age', '600');
        res.statusCode = 204;
        return res.end();
      }

      if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Use POST.');
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
        return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json.');
      }

      const path = (req.url ?? '').split('?')[0];
      if (path === '/v1/health') return await handleHealth(res);
      if (path === '/v1/plan') return await handlePlan(req, res);
      if (path === '/v1/name') return await handleName(req, res);
      if (path === '/v1/control') return await handleControl(req, res);
      return sendError(res, 404, 'not_found', 'Unknown endpoint.');
    } catch (err) {
      return handleError(res, err);
    }
  });

  async function handleHealth(res) {
    const key = await getApiKey();
    sendJson(res, 200, { ok: true, version: VERSION, features: FEATURES, managed: config.managed, pid: process.pid, provider: config.provider, model: config.model, keyConfigured: Boolean(key) });
  }

  async function handlePlan(req, res) {
    if (!limiter.take()) return sendError(res, 429, 'rate_limited', 'Too many requests. Wait a moment.');
    if (inFlight >= 2) return sendError(res, 429, 'busy', 'Still working on the previous request.');

    const body = await readJson(req);
    const request = parsePlanRequest(body);

    const apiKey = await getApiKey();
    if (!apiKey) {
      return sendError(res, 503, 'no_key', 'No API key found. Run "npm run set-key" in the declt folder.');
    }

    inFlight++;
    try {
      const raw = await callModel({
        apiKey,
        model: config.model,
        provider: config.provider,
        body: buildGeminiBody(request, { thinkingBudget: config.thinkingBudget }),
      });
      const plan = normalizePlan(raw, request.tabs);
      sendJson(res, 200, { ok: true, plan, model: config.model });
    } catch (err) {
      if (err instanceof UpstreamError) err.message = redact(err.message, apiKey);
      throw err;
    } finally {
      inFlight--;
    }
  }

  /**
   * Restart or stop this server. Only the extension can ask (the same Origin gate as everything else),
   * and only when a service manager will act on it. The reply is sent first, then the process exits.
   */
  async function handleControl(req, res) {
    const { action } = (await readJson(req)) ?? {};
    if (action !== 'restart' && action !== 'stop') throw new RequestError('action must be "restart" or "stop".');
    if (!config.managed) {
      return sendError(res, 409, 'not_managed', 'This server was started by hand, so it cannot restart itself. Stop it with Ctrl+C and run it again, or install the background service: npm run server:install');
    }
    sendJson(res, 200, { ok: true, action, pid: process.pid });
    res.on('finish', () => setTimeout(() => control[action](), 100));
  }

  async function handleName(req, res) {
    if (!limiter.take()) return sendError(res, 429, 'rate_limited', 'Too many requests. Wait a moment.');
    if (inFlight >= 2) return sendError(res, 429, 'busy', 'Still working on the previous request.');

    const request = parseNameRequest(await readJson(req));
    const apiKey = await getApiKey();
    if (!apiKey) return sendError(res, 503, 'no_key', 'No API key found. Run "npm run set-key" in the declt folder.');

    inFlight++;
    try {
      const raw = await callModel({
        apiKey,
        model: config.model,
        provider: config.provider,
        body: buildNameBody(request, { thinkingBudget: config.thinkingBudget }),
      });
      const name = normalizeName(raw);
      if (!name) throw new UpstreamError('empty_response', 'Could not come up with a name. Try again.', 502);
      sendJson(res, 200, { ok: true, name, model: config.model });
    } catch (err) {
      if (err instanceof UpstreamError) err.message = redact(err.message, apiKey);
      throw err;
    } finally {
      inFlight--;
    }
  }

  function handleError(res, err) {
    if (res.headersSent) return res.end();
    if (err instanceof RequestError || err instanceof UpstreamError) {
      return sendError(res, err.status, err.code, err.message);
    }
    log(`internal error: ${err?.name ?? 'Error'}`);
    return sendError(res, 500, 'internal_error', 'Something went wrong inside the Decltr server.');
  }

  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new RequestError('Request is too large.');
      err.status = 413;
      err.code = 'payload_too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('Body is not valid JSON.');
  }
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}
