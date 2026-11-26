// Second experiment: run Gemini Nano from inside an *extension page* (which is where Decltr's AI calls
// would run), and test whether lowering the sampling randomness makes it more reliable.
//
// Run: node dev/builtin-ai-lab/ext-lab.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromePipe } from './cdp-pipe.mjs';
import { buildCases } from './cases.mjs';
import { buildGeminiBody, normalizePlan, parsePlanRequest, PLAN_SCHEMA } from '../../extension/lib/ai/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(homedir(), 'Library/Caches/decltr-nano-lab-profile'); // same profile: the model is already downloaded
const EXT = join(here, 'ext');
const TRIALS = Number(process.env.LAB_TRIALS ?? 3);
const CASES = (process.env.LAB_ONLY ?? 'group-topic,close-dupes,close-news,injection,off-topic').split(',');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toJsonSchema = (s) =>
  Array.isArray(s) ? s.map(toJsonSchema)
    : s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v)]))
      : s;
const SCHEMA = { ...toJsonSchema(PLAN_SCHEMA), additionalProperties: false };

const browser = launchChromePipe({ profileDir: PROFILE });
await sleep(3000);
const EXT_ID = await browser.loadExtension(EXT);
log('loaded throwaway extension', EXT_ID);
const page = await browser.openPage(`chrome-extension://${EXT_ID}/lab.html`);
await sleep(1500);
const chrome = { version: '(see results)', child: browser.child };

const out = { chrome: chrome.version, startedAt: new Date().toISOString(), configs: {} };
const save = () => writeFileSync(join(here, 'results-ext.json'), JSON.stringify(out, null, 1));

try {
  const inExtension = await page.evaluate('location.protocol + "//" + (typeof LanguageModel)');
  log('page context:', inExtension);
  if (!(await page.evaluate('window.__lab && window.__lab.exists()'))) throw new Error('Extension page did not load, or LanguageModel is missing.');
  out.availability = await page.evaluate('window.__lab.availability()');
  out.params = await page.evaluate('window.__lab.params()');
  log('availability in extension:', out.availability, '| params:', JSON.stringify(out.params));
  if (out.availability !== 'available') throw new Error(`Not available in the extension context: ${out.availability}`);

  const CONFIGS = [
    { name: 'default sampling', sampling: null },
    { name: 'temperature 0, topK 1', sampling: { temperature: 0, topK: 1 } },
  ];
  const all = buildCases().filter((c) => CASES.includes(c.id));

  // Load the model into memory first so timings below are warm.
  await page.evaluate(`window.__lab.run(${JSON.stringify({ system: 'Reply with JSON.', user: '{"a":1}', schema: { type: 'object' } })})`, { timeout: 5 * 60_000 });

  for (const cfg of CONFIGS) {
    const rows = [];
    for (const c of all) {
      const request = parsePlanRequest({ instruction: c.instruction, tabs: c.tabs });
      const body = buildGeminiBody(request, { thinkingBudget: 0 });
      const system = body.systemInstruction.parts[0].text;
      const user = body.contents[0].parts.map((p) => p.text).join('\n\n');
      const trials = [];
      for (let i = 0; i < TRIALS; i++) {
        const r = await page.evaluate(`window.__lab.run(${JSON.stringify({ system, user, schema: SCHEMA, sampling: cfg.sampling })})`, { timeout: 10 * 60_000 });
        const t = { ok: r.ok, ms: Math.round(r.promptMs ?? 0), timedOut: r.timedOut, error: r.error, applied: r.applied };
        if (r.ok) {
          try {
            const raw = JSON.parse(r.output);
            const plan = normalizePlan(raw, request.tabs);
            plan.rawMessage = raw?.message ?? '';
            const s = c.score(plan);
            Object.assign(t, { pass: s.pass, metric: s.metric, failed: s.failed });
          } catch {
            Object.assign(t, { ok: false, pass: false, error: 'invalid JSON' });
          }
        } else {
          t.pass = false;
        }
        trials.push(t);
        log(`[${cfg.name}] ${c.id} trial ${i + 1}/${TRIALS}: ${t.ok ? (t.pass ? 'PASS' : 'FAIL') : 'ERROR'} ${t.ms} ms ${t.metric ?? t.error ?? ''} ${t.applied ? JSON.stringify(t.applied) : ''}`);
      }
      rows.push({ id: c.id, title: c.title, trials });
    }
    out.configs[cfg.name] = rows;
    save();
  }
  out.finishedAt = new Date().toISOString();
  save();
  log('DONE');
} catch (err) {
  out.fatal = err.message;
  save();
  log('FATAL:', err.message);
} finally {
  page.close();
  chrome.child.kill();
}
