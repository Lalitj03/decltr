// The model backends. Each one turns a model-independent "task" (see core.js) into a request for one kind of
// server and returns the JSON object the model produced. Everything after that, the checking of the answer and the
// mapping of tab numbers back to real tabs, is shared and does not care which model answered.
//
//   google  : the Gemini API (AI Studio keys) or Vertex AI (keys that start with "AQ.")
//   openai  : any server that speaks the OpenAI chat API: OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, vLLM, ...
//   ollama  : Ollama's own API, which is more reliable for structured output than its OpenAI compatibility layer

import { geminiBodyFromTask, toJsonSchema } from './core.js';
import { callGemini } from './gemini.js';
import { UpstreamError } from './errors.js';
import { detectKeyType } from './keytype.js';
import { redact } from './redact.js';

const TIMEOUTS = { google: 45_000, openai: 90_000, ollama: 180_000 }; // local models can be slow on first load

/** Pull the JSON object out of model text, tolerating code fences and a sentence before or after it. */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') throw new UpstreamError('bad_response', 'The model sent back something that is not text.');
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value; // the plan is an object, never a list
    } catch {
      /* try the next shape */
    }
  }
  throw new UpstreamError('bad_response', 'The model did not answer in the expected format. Try again, or pick a more capable model.');
}

const userText = (task) => task.userParts.join('\n\n');

/** For models that cannot be forced to follow a schema, also describe the shape in words. */
const systemWithSchema = (task) =>
  `${task.system}\n\nReply with a single JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(toJsonSchema(task.schema))}`;

/** A request that gives up after a deadline, and turns "could not connect" into something a person can act on. */
async function send(url, { headers, body, timeoutMs, label, fetchImpl = fetch, signal }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal && AbortSignal.any ? AbortSignal.any([signal, deadline]) : deadline;
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: combined });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new UpstreamError('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds. A smaller or faster model may help.`, 504);
    }
    if (err?.name === 'AbortError') throw new UpstreamError('aborted', 'Cancelled.', 499);
    throw new UpstreamError('unreachable', `Could not reach ${label} at ${new URL(url).origin}. Check that it is running and that Decltr is allowed to use that address.`, 502);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: errors from some servers are plain text */
  }
  return { res, json, text };
}

/** The server's own error message, trimmed and with any key removed, for showing to a person. */
function detail(json, text, secret) {
  const raw = json?.error?.message ?? json?.error ?? json?.message ?? text ?? '';
  return redact(typeof raw === 'string' ? raw : JSON.stringify(raw), secret).replace(/\s+/g, ' ').trim().slice(0, 240);
}

// ---- Google ----------------------------------------------------------------------------

export function googleBackend({ apiKey, model, thinkingBudget = 0, fetchImpl = fetch }) {
  return {
    name: 'Google Gemini',
    async complete(task, { timeoutMs = TIMEOUTS.google } = {}) {
      return callGemini({
        apiKey,
        model,
        provider: detectKeyType(apiKey) === 'vertex' ? 'vertex' : 'gemini',
        body: geminiBodyFromTask(task, { thinkingBudget }),
        fetchImpl,
        timeoutMs,
      });
    },
  };
}

// ---- OpenAI-compatible -----------------------------------------------------------------

export function openAiBackend({ baseUrl, apiKey, model, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const label = 'the model server';

  return {
    name: 'OpenAI-compatible server',
    async complete(task, { timeoutMs = TIMEOUTS.openai, signal } = {}) {
      const messages = [
        { role: 'system', content: systemWithSchema(task) },
        { role: 'user', content: userText(task) },
      ];
      // Servers differ in what they accept, so start with the strictest and step down when one says no.
      const formats = [
        { type: 'json_schema', json_schema: { name: `decltr_${task.kind}`, schema: toJsonSchema(task.schema), strict: false } },
        { type: 'json_object' },
        null,
      ];
      let sendTemperature = true;
      let last;

      for (let i = 0; i < formats.length; ) {
        const body = { model, messages, ...(sendTemperature ? { temperature: task.temperature } : {}), ...(formats[i] ? { response_format: formats[i] } : {}) };
        const { res, json, text } = await send(url, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body, timeoutMs, label, fetchImpl, signal,
        });
        last = { res, json, text };

        if (res.ok) {
          const content = json?.choices?.[0]?.message?.content;
          if (!content) throw new UpstreamError('empty_response', 'The model sent back an empty answer. Try again.');
          return parseJsonLoose(content);
        }
        const message = detail(json, text, apiKey);
        const rejectedSetting = res.status === 400 || res.status === 422;
        if (rejectedSetting && sendTemperature && /temperature/i.test(message)) {
          sendTemperature = false; // some reasoning models only allow their default
          continue;
        }
        if (rejectedSetting && i < formats.length - 1) {
          i++;
          continue;
        }
        break;
      }
      throw openAiError(last.res.status, detail(last.json, last.text, apiKey), model);
    },
  };
}

function openAiError(status, message, model) {
  if (status === 401 || status === 403) return new UpstreamError('bad_key', `The server refused the API key${message ? `: ${message}` : '.'}`, status);
  if (status === 404) return new UpstreamError('model_not_found', `The server does not know the model "${model}"${message ? ` (${message})` : ''}. Check the model name.`, 404);
  if (status === 429) return new UpstreamError('rate_limited', 'The server says you are sending too many requests, or your quota is used up. Wait a moment and try again.', 429);
  if (status === 402) return new UpstreamError('billing', `The server says your account needs credit${message ? `: ${message}` : '.'}`, 402);
  return new UpstreamError('upstream_error', `The model server returned an error (${status})${message ? `: ${message}` : '.'}`, 502);
}

// ---- Ollama ----------------------------------------------------------------------------

/**
 * Ollama gives every request a small context window by default (a few thousand tokens) and silently drops
 * whatever does not fit, which would cut tabs off the end of the list. Size it to the request instead.
 */
export function contextFor(task, { max = 16_384 } = {}) {
  const chars = task.system.length + task.userParts.join('').length + JSON.stringify(toJsonSchema(task.schema)).length;
  const tokens = Math.ceil(chars / 3) + 1_024; // a pessimistic 3 characters per token, plus room to answer
  return Math.min(max, Math.max(4_096, Math.ceil(tokens / 1_024) * 1_024));
}

export const OLLAMA_ORIGIN_HELP =
  'Ollama refused this extension (HTTP 403). Allow it with OLLAMA_ORIGINS=chrome-extension://* and restart Ollama. On a Mac with the Ollama app: launchctl setenv OLLAMA_ORIGINS "chrome-extension://*", then quit and reopen Ollama.';

export function ollamaBackend({ baseUrl, model, maxContext = 16_384, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    name: 'Ollama',
    async complete(task, { timeoutMs = TIMEOUTS.ollama, signal } = {}) {
      const { res, json, text } = await send(`${root}/api/chat`, {
        body: {
          model,
          stream: false,
          messages: [
            { role: 'system', content: systemWithSchema(task) },
            { role: 'user', content: userText(task) },
          ],
          format: toJsonSchema(task.schema),
          options: { temperature: task.temperature, num_ctx: contextFor(task, { max: maxContext }) },
        },
        timeoutMs, label: 'Ollama', fetchImpl, signal,
      });

      if (res.ok) {
        const content = json?.message?.content;
        if (!content) throw new UpstreamError('empty_response', 'Ollama sent back an empty answer. The model may still be loading, or may be a thinking model that ran out of room. Try again.');
        return parseJsonLoose(content);
      }
      const message = detail(json, text);
      if (res.status === 403) throw new UpstreamError('origin_blocked', OLLAMA_ORIGIN_HELP, 403);
      if (res.status === 404 || /not found/i.test(message)) {
        throw new UpstreamError('model_not_found', `Ollama does not have the model "${model}". Download it with: ollama pull ${model}`, 404);
      }
      throw new UpstreamError('upstream_error', `Ollama returned an error (${res.status})${message ? `: ${message}` : '.'}`, 502);
    },
  };
}

/** The models the user has downloaded in Ollama, to offer them instead of making people remember names. */
export async function listOllamaModels(baseUrl, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new UpstreamError('unreachable', `Could not reach Ollama at ${new URL(baseUrl).origin}. Check that it is running.`, 502);
  }
  if (res.status === 403) throw new UpstreamError('origin_blocked', OLLAMA_ORIGIN_HELP, 403);
  if (!res.ok) throw new UpstreamError('upstream_error', `Ollama returned an error (${res.status}).`, 502);
  const json = await res.json().catch(() => null);
  return (Array.isArray(json?.models) ? json.models : []).map((m) => m?.name).filter((n) => typeof n === 'string' && n).sort();
}
