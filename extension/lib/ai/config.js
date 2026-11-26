// Which model Decltr uses, and the settings for each choice. Stored only in this browser profile
// (chrome.storage.local): never synced, and never included in anything the extension sends to a model.

import { detectKeyType } from './keytype.js';

export const AI_KEY = 'decltr.ai';

/**
 *  server : the optional local Decltr server (keeps the key in the macOS Keychain)
 *  google : a Google Gemini API key, or a Vertex AI key, used directly from the extension
 *  openai : any OpenAI-compatible server (OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, vLLM, ...)
 *  ollama : a local Ollama
 */
export const AI_PROVIDERS = ['server', 'google', 'openai', 'ollama'];

export const PROVIDER_NAMES = {
  server: 'Decltr server',
  google: 'Google Gemini',
  openai: 'OpenAI-compatible',
  ollama: 'Ollama',
};

export const DEFAULT_AI_CONFIG = Object.freeze({
  provider: 'server',
  google: { apiKey: '', model: 'gemini-3.5-flash-lite' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: '', maxContext: 16_384 },
});

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const SECRET = /^[^\s\u0000-\u001f\u007f]{8,400}$/;

// This machine, or somewhere on a home or office network: these servers speak plain http, not https.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?(\/|$)/i;

/**
 * A clean http(s) address with no trailing slash, or null. Credentials, query strings and fragments are refused.
 * People type "localhost:11434" or "api.groq.com/openai/v1", so a missing scheme is filled in:
 * http for this machine and local network names, https for everything else.
 */
export function cleanBaseUrl(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !LOCAL_HOST.test(text) && !/^[^/]*:\d+(\/|$)/.test(text)) return null; // javascript:, data:, ...
    text = `${LOCAL_HOST.test(text) ? 'http' : 'https'}://${text}`;
  }
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Accept anything that was stored or typed, and return a config that is safe to use. Bad fields fall back to defaults. */
export function normalizeAiConfig(raw) {
  const d = DEFAULT_AI_CONFIG;
  const r = raw && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const model = (v, fallback) => (MODEL.test(text(v)) ? text(v) : fallback);
  const secret = (v) => (SECRET.test(text(v)) ? text(v) : '');

  return {
    provider: AI_PROVIDERS.includes(r.provider) ? r.provider : d.provider,
    google: { apiKey: secret(r.google?.apiKey), model: model(r.google?.model, d.google.model) },
    openai: {
      baseUrl: cleanBaseUrl(r.openai?.baseUrl) ?? d.openai.baseUrl,
      apiKey: secret(r.openai?.apiKey),
      model: model(r.openai?.model, ''),
    },
    ollama: {
      baseUrl: cleanBaseUrl(r.ollama?.baseUrl) ?? d.ollama.baseUrl,
      model: model(r.ollama?.model, ''),
      maxContext: Number.isInteger(r.ollama?.maxContext) && r.ollama.maxContext >= 2_048 && r.ollama.maxContext <= 131_072 ? r.ollama.maxContext : d.ollama.maxContext,
    },
  };
}

/** True when the chosen provider has everything it needs. For the server we cannot know until we ask it. */
export function isConfigured(config) {
  const c = normalizeAiConfig(config);
  switch (c.provider) {
    case 'google': return Boolean(c.google.apiKey && c.google.model);
    case 'openai': return Boolean(c.openai.baseUrl && c.openai.model);
    case 'ollama': return Boolean(c.ollama.baseUrl && c.ollama.model);
    default: return true;
  }
}

/** Why a provider is not ready, in words for the person using it. Empty string when it is. */
export function missingSetup(config) {
  const c = normalizeAiConfig(config);
  if (c.provider === 'google') {
    if (!c.google.apiKey) return 'Paste your Gemini API key.';
    if (!detectKeyType(c.google.apiKey)) return 'That key is not in a format I recognise. A Gemini key starts with "AIza" and a Vertex AI key with "AQ.".';
  }
  if (c.provider === 'openai' && !c.openai.model) return 'Enter the model name to use.';
  if (c.provider === 'ollama' && !c.ollama.model) return 'Enter the name of an Ollama model you have downloaded, for example llama3.2.';
  return '';
}

/** The website the extension must be allowed to contact for the chosen provider, as a match pattern. */
export function requiredOrigins(config) {
  const c = normalizeAiConfig(config);
  const pattern = (url) => `${new URL(url).origin}/*`;
  switch (c.provider) {
    case 'google': return [detectKeyType(c.google.apiKey) === 'vertex' ? 'https://aiplatform.googleapis.com/*' : 'https://generativelanguage.googleapis.com/*'];
    case 'openai': return [pattern(c.openai.baseUrl)];
    case 'ollama': return [pattern(c.ollama.baseUrl)];
    default: return [];
  }
}

export async function loadAiConfig() {
  return normalizeAiConfig((await chrome.storage.local.get(AI_KEY))[AI_KEY]);
}

export async function saveAiConfig(config) {
  const clean = normalizeAiConfig(config);
  await chrome.storage.local.set({ [AI_KEY]: clean });
  return clean;
}
