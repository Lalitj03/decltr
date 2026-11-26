import { listOllamaModels } from './lib/ai/backends.js';
import {
  cleanBaseUrl, consentTarget, DEFAULT_AI_CONFIG, describeDestination, hasConsent, isConfigured, missingSetup, normalizeAiConfig, PROVIDER_NAMES, requiredOrigins, saveAiConfig,
} from './lib/ai/config.js';
import { testProvider } from './lib/ai/index.js';
import { requestAccess, syncOriginRule } from './lib/ai/network.js';

const HELP = {
  server:
    'Uses the optional Decltr server on this computer, which keeps your API key in the macOS Keychain. Set it up with npm run server:install.',
  google:
    'Your key is stored in this browser only and is sent only to Google. When you use an AI action, tab titles and addresses (without anything after "?" or "#") are sent to Google.',
  ollama:
    'Runs on your computer, so tab details never leave it. Ollama must be running, with a model downloaded (for example: ollama pull llama3.2). Small models can be slower and less accurate.',
  openai:
    'Works with OpenAI, OpenRouter, Groq, LM Studio, llama.cpp and anything else that speaks the OpenAI API. Tab titles and addresses (without anything after "?" or "#") are sent to that server.',
};

/** The "AI model" box in settings: choose a model, enter its details, and check that it works. */
export function createAiSettings({ els, getConfig, onSaved }) {
  const fieldsFor = (provider) => document.getElementById(`aiFields-${provider}`);

  function showFields(provider) {
    for (const p of ['google', 'ollama', 'openai']) fieldsFor(p).hidden = p !== provider;
    els.help.textContent = HELP[provider] ?? '';
    els.save.textContent = provider === 'server' ? 'Check the server' : 'Save and test';
  }

  /** Fill the form from saved settings. Saved keys are never put back into the page. */
  function render(config = getConfig()) {
    const c = normalizeAiConfig(config);
    els.provider.value = c.provider;
    els.googleModel.value = c.google.model;
    els.googleKey.value = '';
    els.googleKey.placeholder = c.google.apiKey ? 'Saved. Paste a new key to replace it.' : 'AIza… or AQ.…';
    els.googleForget.hidden = !c.google.apiKey;
    els.ollamaUrl.value = c.ollama.baseUrl;
    els.ollamaModel.value = c.ollama.model;
    els.openaiUrl.value = c.openai.baseUrl;
    els.openaiModel.value = c.openai.model;
    els.openaiKey.value = '';
    els.openaiKey.placeholder = c.openai.apiKey ? 'Saved. Paste a new key to replace it.' : '';
    els.openaiForget.hidden = !c.openai.apiKey;
    showFields(c.provider);
    renderState();
  }

  function renderState() {
    const c = normalizeAiConfig(getConfig());
    els.state.textContent = c.provider === 'server' ? 'Decltr server' : isConfigured(c) ? PROVIDER_NAMES[c.provider] : 'Not set up';
  }

  function setResult(text, kind = '') {
    els.result.textContent = text;
    els.result.className = `ai-result ${kind}`.trim();
  }

  /** What was typed, turned into settings. A blank key field means "keep the saved one". */
  function readForm() {
    const base = normalizeAiConfig(getConfig());
    return normalizeAiConfig({
      provider: els.provider.value,
      google: { apiKey: els.googleKey.value.trim() || base.google.apiKey, model: els.googleModel.value.trim() || DEFAULT_AI_CONFIG.google.model },
      openai: { baseUrl: els.openaiUrl.value, apiKey: els.openaiKey.value.trim() || base.openai.apiKey, model: els.openaiModel.value.trim() },
      ollama: { baseUrl: els.ollamaUrl.value, model: els.ollamaModel.value.trim(), maxContext: base.ollama.maxContext },
      consent: base.consent,
    });
  }

  /** Mistakes that normalising would hide by quietly using a default, so say so instead. */
  function typedMistake(provider) {
    const field = { ollama: els.ollamaUrl, openai: els.openaiUrl }[provider];
    if (field && field.value.trim() && !cleanBaseUrl(field.value)) {
      return 'That address does not look right. It should look like http://127.0.0.1:11434 or https://api.openai.com/v1, with nothing after a "?".';
    }
    return '';
  }

  async function ask(config) {
    const allowed = await requestAccess(config);
    if (allowed) return true;
    const where = requiredOrigins(config).map((o) => o.replace('/*', '')).join(', ');
    setResult(`Chrome needs your permission to contact ${where}. Press the button again and choose Allow.`, 'bad');
    return false;
  }

  /**
   * Before tab details can go to another computer, say exactly what is sent and where, and wait for a click on
   * "Agree and continue". Shown once per destination, so a new key for the same service does not ask again,
   * but a different service does. Ollama on this computer never asks, because nothing leaves it.
   */
  function showConsent(config) {
    const where = describeDestination(config);
    els.consentTitle.textContent = `Send tab details to ${where}?`;
    els.consentText.textContent =
      `When you use an AI action or AI naming, Decltr sends your request and the titles and addresses of the tabs involved ` +
      `(without anything after "?" or "#") to ${where}. That service's own privacy policy applies to them. ` +
      (config.provider === 'google'
        ? `With a free Gemini API key, Google may use what it receives to improve its products, and people at Google may read it. ` +
          `A key from a project with billing turned on is not used that way. `
        : '') +
      `Nothing is sent until you use an AI action, and quick actions marked On-device never send anything. ` +
      `Decltr has no server of its own and collects nothing. You can change this at any time by choosing another model or forgetting the key.`;
    els.consent.hidden = false;
    els.save.hidden = true;
    setResult('');
    els.consentYes.focus();
  }

  function hideConsent() {
    els.consent.hidden = true;
    els.save.hidden = false;
  }

  async function saveAndTest({ agreed = false } = {}) {
    els.save.disabled = true;
    setResult('Checking…', 'busy');
    try {
      const mistake = typedMistake(els.provider.value);
      if (mistake) return setResult(mistake, 'bad');
      let config = readForm();
      const problem = missingSetup(config);
      if (problem) return setResult(problem, 'bad');
      if (!hasConsent(config)) {
        if (!agreed) return showConsent(config);
        config = { ...config, consent: [...config.consent, consentTarget(config)] };
      }
      hideConsent();

      // Chrome only shows its permission prompt in response to a click, so this must come before the other awaits.
      if (!(await ask(config))) return;

      const saved = await saveAiConfig(config);
      await syncOriginRule(saved);
      onSaved(saved);
      render(saved);
      setResult('Checking…', 'busy');
      const result = await testProvider(saved);
      setResult(result.message, result.ok ? 'ok' : 'bad');
      onSaved(saved, result);
    } catch (err) {
      setResult(err?.message ?? 'That did not work.', 'bad');
    } finally {
      els.save.disabled = false;
    }
  }

  async function findModels() {
    els.ollamaFind.disabled = true;
    setResult('Looking…', 'busy');
    try {
      const mistake = typedMistake('ollama');
      if (mistake) return setResult(mistake, 'bad');
      const config = normalizeAiConfig({ ...readForm(), provider: 'ollama' });
      if (!(await ask(config))) return;
      await syncOriginRule(config); // without this Ollama refuses even the request for its model list
      const names = await listOllamaModels(config.ollama.baseUrl);
      els.ollamaModels.replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));
      if (names.length === 0) return setResult('Ollama is running but has no models yet. Download one, for example: ollama pull llama3.2', 'bad');
      if (!els.ollamaModel.value.trim()) els.ollamaModel.value = names[0];
      setResult(`Found ${names.length} model${names.length === 1 ? '' : 's'}. Pick one, then press Save and test.`, 'ok');
    } catch (err) {
      setResult(err?.message ?? 'That did not work.', 'bad');
    } finally {
      els.ollamaFind.disabled = false;
    }
  }

  async function forget(provider) {
    const c = normalizeAiConfig(getConfig());
    // Forgetting the key also withdraws the agreement, so entering a key again asks again.
    const withdrawn = consentTarget({ ...c, provider });
    const next = { ...c, [provider]: { ...c[provider], apiKey: '' }, consent: c.consent.filter((o) => o !== withdrawn) };
    const saved = await saveAiConfig(next);
    onSaved(saved);
    render(saved);
    setResult('Key removed from this browser.', 'ok');
  }

  els.provider.addEventListener('change', () => {
    showFields(els.provider.value);
    hideConsent();
    setResult('');
  });
  els.save.addEventListener('click', () => saveAndTest());
  // The click on Agree is also what lets Chrome show its permission prompt next.
  els.consentYes.addEventListener('click', () => saveAndTest({ agreed: true }));
  els.consentNo.addEventListener('click', () => {
    hideConsent();
    setResult('Not saved. Nothing was sent.', '');
  });
  els.ollamaFind.addEventListener('click', findModels);
  els.googleForget.addEventListener('click', () => forget('google'));
  els.openaiForget.addEventListener('click', () => forget('openai'));

  return {
    render,
    renderState,
    /** Show a provider's fields (used by the "choose how Decltr should think" card). */
    choose(provider) {
      els.provider.value = provider;
      showFields(provider);
      setResult('');
    },
  };
}
