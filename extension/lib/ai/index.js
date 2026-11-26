// The one entry point the panel uses to ask a model for something. It picks the backend from the saved
// settings, so the rest of the extension never needs to know which model is answering.

import { checkHealth, requestPlan, suggestName as serverSuggestName } from '../api.js';
import { googleBackend, ollamaBackend, openAiBackend } from './backends.js';
import { describeDestination, hasConsent, isConfigured, missingSetup, normalizeAiConfig, PROVIDER_NAMES } from './config.js';
import { UpstreamError } from './errors.js';
import { nameTask, normalizeName, normalizePlan, parsePlanRequest, planTask } from './core.js';
import { cleanText } from './core.js';

export function createBackend(config, { fetchImpl = fetch } = {}) {
  const c = normalizeAiConfig(config);
  const problem = missingSetup(c);
  if (problem) throw new UpstreamError('not_configured', problem, 400);
  // Nothing goes to another computer unless the person agreed to that destination in settings.
  if (!hasConsent(c)) {
    throw new UpstreamError('no_consent', `Open Settings → AI model and press Save to agree to sending tab details to ${describeDestination(c)}.`, 400);
  }
  switch (c.provider) {
    case 'google': return googleBackend({ ...c.google, fetchImpl });
    case 'openai': return openAiBackend({ ...c.openai, fetchImpl });
    case 'ollama': return ollamaBackend({ ...c.ollama, maxContext: c.ollama.maxContext, fetchImpl });
    default: throw new UpstreamError('bad_provider', 'This provider does not run from the extension.', 500);
  }
}

/**
 * Ask for a plan. `tabs` are the panel's tabs ({ id, title, url, group?, active?, audible? }).
 * The result has real tab IDs. Nothing the model says is trusted: IDs it invents are dropped.
 */
export async function planWithAI({ instruction, tabs }, config, { fetchImpl } = {}) {
  const c = normalizeAiConfig(config);
  if (c.provider === 'server') return (await requestPlan({ instruction, tabs })).plan;

  // Tabs are cleaned here, before anything leaves the browser: no query strings, no fragments, capped lengths.
  const request = parsePlanRequest({ instruction, tabs });
  const raw = await createBackend(c, { fetchImpl }).complete(planTask(request));
  const plan = normalizePlan(raw, request.tabs);
  plan.rawMessage = cleanText(raw?.message, 400);
  return plan;
}

/** Suggest a short name for a set of tabs ({ title, url, group? }). */
export async function nameWithAI(tabs, config, { fetchImpl } = {}) {
  const c = normalizeAiConfig(config);
  if (c.provider === 'server') return serverSuggestName(tabs);

  const cleaned = tabs
    .slice(0, 60)
    .map((t) => ({ title: cleanText(t.title, 120), url: safeOrigin(t.url), group: cleanText(t.group, 40) || undefined }))
    .filter((t) => t.title || t.url);
  if (cleaned.length === 0) throw new UpstreamError('bad_request', 'There is nothing to name.', 400);
  const raw = await createBackend(c, { fetchImpl }).complete(nameTask({ tabs: cleaned }));
  const name = normalizeName(raw);
  if (!name) throw new UpstreamError('empty_response', 'The model did not come up with a name. Try again.');
  return name;
}

// Naming only needs where a page is from and what it is called, so keep the path but never a query or fragment.
function safeOrigin(value) {
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}`.slice(0, 160) : u.origin;
  } catch {
    return '';
  }
}

/**
 * Try the chosen provider with a tiny request. Never throws: returns { ok, message, ms, code }.
 * The message is written to be shown as it is.
 */
export async function testProvider(config, { fetchImpl } = {}) {
  const c = normalizeAiConfig(config);
  const started = Date.now();
  try {
    if (c.provider === 'server') {
      const info = await checkHealth();
      return info.keyConfigured
        ? { ok: true, message: `The Decltr server is running (v${info.version}) and has an API key.`, ms: Date.now() - started }
        : { ok: false, code: 'no_key', message: 'The Decltr server is running but has no API key. Run: npm run set-key', ms: Date.now() - started };
    }
    if (!isConfigured(c)) return { ok: false, code: 'not_configured', message: missingSetup(c), ms: 0 };
    const sample = [
      { title: 'Flights to Lisbon', url: 'https://www.google.com/travel/flights' },
      { title: 'Hotels in Lisbon', url: 'https://www.booking.com/city/pt/lisbon.html' },
    ];
    const name = await nameWithAI(sample, c, { fetchImpl });
    const ms = Date.now() - started;
    return { ok: true, message: `${PROVIDER_NAMES[c.provider]} works. It suggested "${name}" in ${(ms / 1000).toFixed(1)} s.`, ms };
  } catch (err) {
    return { ok: false, code: err?.code ?? 'error', message: err?.message ?? 'That did not work.', ms: Date.now() - started };
  }
}
