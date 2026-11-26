// The browser-side plumbing for talking to a model server:
//  - asking Chrome for permission to reach the address the user chose, and only that address
//  - making Ollama accept the extension, which it otherwise rejects with HTTP 403

import { normalizeAiConfig, requiredOrigins } from './config.js';

const RULE_ID = 1001;

/**
 * Ollama only accepts browsers from this machine and answers an extension with 403. While Ollama is the chosen
 * model, requests this extension makes to Ollama's address carry this origin instead. The rule is limited to
 * requests the extension itself makes, to that one address, and it is removed when another model is chosen.
 */
export const OLLAMA_FRIENDLY_ORIGIN = 'http://127.0.0.1';

/** True when Chrome already lets the extension reach the chosen address (or none is needed). */
export async function hasAccess(config) {
  const origins = requiredOrigins(config);
  return origins.length === 0 || chrome.permissions.contains({ origins });
}

/**
 * Ask Chrome to allow the chosen address. Chrome shows its own prompt, and only accepts the request
 * while handling a click, so call this straight from a button handler.
 */
export async function requestAccess(config) {
  const origins = requiredOrigins(config);
  if (origins.length === 0) return true;
  if (await chrome.permissions.contains({ origins })) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** Install the Origin rule for Ollama, or remove it when something else is chosen. Safe to call any time. */
export async function syncOriginRule(config) {
  const c = normalizeAiConfig(config);
  const dnr = chrome.declarativeNetRequest;
  if (!dnr) return false;

  if (c.provider !== 'ollama') {
    await dnr.updateDynamicRules({ removeRuleIds: [RULE_ID] });
    return false;
  }
  const origin = new URL(c.ollama.baseUrl).origin;
  await dnr.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'set', value: OLLAMA_FRIENDLY_ORIGIN }] },
        condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
      },
    ],
  });
  return true;
}
