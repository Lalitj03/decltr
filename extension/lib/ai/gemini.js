import { redact } from './redact.js';
import { UpstreamError } from './errors.js';

export { UpstreamError };

const ENDPOINTS = {
  vertex: 'https://aiplatform.googleapis.com/v1/publishers/google/models/',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/',
};

/**
 * Call Gemini's generateContent and return the parsed JSON the model produced.
 * The key is sent in a header (not the URL) and scrubbed from any error text.
 */
export async function callGemini({ apiKey, model, body, provider = 'vertex', fetchImpl = fetch, timeoutMs = 45_000 }) {
  const endpoint = ENDPOINTS[provider];
  if (!endpoint) throw new UpstreamError('bad_provider', `Unknown provider "${provider}".`, 500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res;
    try {
      res = await fetchImpl(`${endpoint}${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new UpstreamError('upstream_timeout', 'Gemini took too long to respond. Try again.', 504);
      }
      throw new UpstreamError('upstream_unreachable', 'Could not reach Gemini. Check your internet connection.', 502);
    }

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* handled below */
    }

    if (!res.ok) throw mapHttpError(res.status, json, apiKey);

    if (json?.promptFeedback?.blockReason) {
      throw new UpstreamError('blocked', 'Gemini declined to process this request.', 422);
    }
    const candidate = json?.candidates?.[0];
    const out = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!out) {
      throw new UpstreamError('empty_response', 'Gemini returned an empty answer. Try again.', 502);
    }
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new UpstreamError('truncated', 'The plan was too large. Try a more specific instruction.', 502);
    }
    try {
      return JSON.parse(out);
    } catch {
      throw new UpstreamError('bad_response', 'Gemini returned something unreadable. Try again.', 502);
    }
  } finally {
    clearTimeout(timer);
  }
}

function mapHttpError(status, json, apiKey) {
  const detail = redact(json?.error?.message ?? '', apiKey).slice(0, 200);
  if (status === 402) {
    return new UpstreamError(
      'billing',
      'Your Gemini credits are used up. Add credits or billing for this Google Cloud project in AI Studio (aistudio.google.com), then try again.',
      402,
    );
  }
  if (status === 429) {
    return new UpstreamError('rate_limited', 'Gemini rate limit reached. Wait a moment and try again.', 429);
  }
  if (status === 400 && /api key/i.test(detail)) {
    return new UpstreamError('bad_key', 'Google rejected the API key. Run "npm run set-key" with a valid key.', 502);
  }
  if (status === 401 || status === 403) {
    return new UpstreamError('bad_key', 'Google refused the request. Check the API key, that it is bound to a service account with Vertex AI access, and that the API is enabled.', 502);
  }
  if (status === 404) {
    return new UpstreamError('bad_model', 'The configured Gemini model was not found. Check DECLTR_MODEL.', 502);
  }
  return new UpstreamError('upstream_error', `Gemini returned an error (${status}). Try again.`, 502);
}
