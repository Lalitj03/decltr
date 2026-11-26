// Compare Chrome's built-in model (Gemini Nano) with Gemini on Vertex for Decltr's two AI tasks:
//   1. turning an instruction + open tabs into a tab plan
//   2. naming a saved session
//
// Both engines get the exact same prompt, and both outputs go through the exact same
// validator (normalizePlan) and objective scoring, so the comparison is like for like.
//
// Run:  node dev/builtin-ai-lab/lab.mjs            (opens a separate Chrome window with a throwaway profile)
// Output: dev/builtin-ai-lab/results.json and REPORT.md
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage } from './cdp.mjs';
import { buildCases, NAME_CASES, scoreName } from './cases.mjs';
import {
  buildGeminiBody, buildNameBody, NAME_SCHEMA, normalizeName, normalizePlan, parsePlanRequest, PLAN_SCHEMA,
} from '../../extension/lib/ai/core.js';
import { callGemini } from '../../extension/lib/ai/gemini.js';
import { readApiKey } from '../../server/src/keychain.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(homedir(), 'Library/Caches/decltr-nano-lab-profile');
const MODEL = process.env.DECLTR_MODEL ?? 'gemini-3.5-flash-lite';
const TRIALS = Number(process.env.LAB_TRIALS ?? 3);
const only = process.env.LAB_ONLY?.split(',');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Prompt API takes standard JSON Schema; our Gemini schema uses upper-case type names.
const toJsonSchema = (s) => {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (s && typeof s === 'object') {
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v)]));
  }
  return s;
};
const PLAN_JSON_SCHEMA = { ...toJsonSchema(PLAN_SCHEMA), additionalProperties: false };
const NAME_JSON_SCHEMA = { ...toJsonSchema(NAME_SCHEMA), additionalProperties: false };

const apiKey = await readApiKey('vertex');
if (!apiKey) throw new Error('No Vertex key in the Keychain (needed for the cloud reference).');

// ---- engines -----------------------------------------------------------------------

const cloud = {
  name: 'Gemini (cloud)',
  async run(body) {
    const t = performance.now();
    try {
      const out = await callGemini({ apiKey, model: MODEL, provider: 'vertex', body });
      return { ok: true, output: out, promptMs: performance.now() - t };
    } catch (e) {
      return { ok: false, error: `${e.code ?? e.name}: ${e.message}`, promptMs: performance.now() - t };
    }
  },
};

let page;
const nano = {
  name: 'Gemini Nano (built-in)',
  async run(body, schema) {
    const system = body.systemInstruction.parts[0].text;
    const user = body.contents[0].parts.map((p) => p.text).join('\n\n');
    const r = await page.evaluate(`window.__lab.run(${JSON.stringify({ system, user, schema })})`, { timeout: 15 * 60_000 });
    if (!r.ok) return r;
    try {
      return { ...r, output: JSON.parse(r.output) };
    } catch {
      return { ...r, ok: false, error: 'Output was not valid JSON', raw: String(r.output).slice(0, 200) };
    }
  },
};

// ---- bring up Chrome and the model -----------------------------------------------------

const server = http.createServer((q, s) => {
  s.setHeader('content-type', 'text/html');
  s.end(readFileSync(join(here, 'lab.html')));
}).listen(5181, '127.0.0.1');

log('launching a separate Chrome with a throwaway profile…');
const chrome = await launchChrome({ profileDir: PROFILE });
log('Chrome', chrome.version);
page = await openPage(chrome.port, 'http://localhost:5181/');
await sleep(1500);

const env = { chrome: chrome.version, model: MODEL, trials: TRIALS, platform: process.platform, startedAt: new Date().toISOString() };
const results = { env, plan: [], naming: [], setup: {} };
const save = () => writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 1));

try {
  if (!(await page.evaluate('window.__lab.exists()'))) throw new Error('LanguageModel API is not exposed in this Chrome.');
  let availability = await page.evaluate('window.__lab.availability()');
  log('availability:', availability);
  results.setup.initialAvailability = availability;

  if (availability === 'unavailable') throw new Error('Built-in model is unavailable on this machine/profile.');
  if (availability !== 'available') {
    const t0 = Date.now();
    log('starting model download (needs a user gesture, supplied by the runner)…');
    await page.evaluate('window.__lab.startDownload()', { userGesture: true });
    let last = -1;
    for (;;) {
      await sleep(5000);
      const dl = await page.evaluate('window.__lab.dl()');
      const pct = Math.floor((dl?.loaded ?? 0) * 100);
      if (pct !== last) log(`download ${pct}% (${dl?.state})`), (last = pct);
      if (dl?.state === 'error') throw new Error(`Download failed: ${dl.error}`);
      if (dl?.state === 'done') break;
      if (Date.now() - t0 > 60 * 60_000) throw new Error('Download took longer than 60 minutes.');
    }
    results.setup.downloadSeconds = Math.round((Date.now() - t0) / 1000);
    availability = await page.evaluate('window.__lab.availability()');
    log('availability after download:', availability);
  }
  results.setup.finalAvailability = availability;

  // Warm-up: the first prompt after startup loads the model into memory and is much slower.
  const warm = await nano.run({ systemInstruction: { parts: [{ text: 'Reply with JSON.' }] }, contents: [{ parts: [{ text: '{"hello": 1} -> name' }] }] }, NAME_JSON_SCHEMA);
  results.setup.firstPromptSeconds = warm.promptMs ? +(((warm.createMs ?? 0) + warm.promptMs) / 1000).toFixed(1) : null;
  results.setup.contextWindow = warm.contextWindow ?? null;
  log('warm-up done, context window:', warm.contextWindow, 'first prompt s:', results.setup.firstPromptSeconds);
  save();

  // ---- task 1: tab plans -----------------------------------------------------------------
  for (const c of buildCases()) {
    if (only && !only.includes(c.id)) continue;
    const request = parsePlanRequest({ instruction: c.instruction, tabs: c.tabs });
    const body = buildGeminiBody(request, { thinkingBudget: 0 });
    const row = { id: c.id, title: c.title, tabs: c.tabs.length, engines: {} };
    for (const engine of [cloud, nano]) {
      const trials = [];
      const n = c.scale ? Math.min(TRIALS, 2) : TRIALS;
      for (let i = 0; i < n; i++) {
        const r = await (engine === nano ? engine.run(body, PLAN_JSON_SCHEMA) : engine.run(body));
        const trial = { ok: r.ok, timedOut: r.timedOut, ms: Math.round(r.promptMs ?? r.createMs ?? 0), error: r.error, window: r.window, requested: r.requested, contextUsed: r.usedAfter };
        if (r.ok) {
          const plan = normalizePlan(r.output, request.tabs);
          plan.rawMessage = r.output?.message ?? '';
          const s = c.score(plan);
          Object.assign(trial, { pass: s.pass, checks: s.checks, failed: s.failed, metric: s.metric, f1: s.f1, groupNames: plan.actions.filter((a) => a.type === 'group').map((a) => a.name) });
        } else {
          trial.pass = false;
        }
        trials.push(trial);
        log(`${c.id} | ${engine.name} | trial ${i + 1}/${n}: ${trial.ok ? (trial.pass ? 'PASS' : 'FAIL') : 'ERROR'} ${trial.ms} ms ${trial.metric ?? trial.error ?? ''}`);
      }
      row.engines[engine.name] = trials;
    }
    results.plan.push(row);
    save();
  }

  // ---- task 2: naming -----------------------------------------------------------------------
  for (const c of NAME_CASES) {
    if (only && !only.includes('naming')) continue;
    const body = buildNameBody({ tabs: c.tabs.map((t) => ({ title: t.title, url: t.url })) }, { thinkingBudget: 0 });
    const row = { id: c.id, hint: c.hint, engines: {} };
    for (const engine of [cloud, nano]) {
      const trials = [];
      for (let i = 0; i < TRIALS; i++) {
        const r = await (engine === nano ? engine.run(body, NAME_JSON_SCHEMA) : engine.run(body));
        const name = r.ok ? normalizeName(r.output) : '';
        const s = r.ok ? scoreName(name, c.id) : { pass: false, failed: [r.error] };
        trials.push({ ok: r.ok, ms: Math.round(r.promptMs ?? 0), name, pass: r.ok && s.pass, failed: s.failed, error: r.error });
        log(`${c.id} | ${engine.name} | "${name}" ${s.pass ? 'ok' : 'FAIL ' + (s.failed ?? []).join('; ')} ${Math.round(r.promptMs ?? 0)} ms`);
      }
      row.engines[engine.name] = trials;
    }
    results.naming.push(row);
    save();
  }
  results.finishedAt = new Date().toISOString();
  save();
  log('DONE. results saved to dev/builtin-ai-lab/results.json');
} catch (err) {
  results.fatal = err.message;
  save();
  log('FATAL:', err.message);
} finally {
  page.close();
  server.close();
  chrome.child.kill();
}
