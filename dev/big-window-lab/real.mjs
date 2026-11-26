// The shipped planner (planWithAI) on the synthetic window, against a real model. Key from stdin.
//   security find-generic-password -s decltr -a vertex-api-key -w | node dev/big-window-lab/real.mjs 650 [runs=1] [mode=auto|single|parts]
import { planWithAI } from '../../extension/lib/ai/index.js';
import { planInParts } from '../../extension/lib/ai/parts.js';
import { createBackend } from '../../extension/lib/ai/index.js';
import { cleanText, normalizePlan, parsePlanRequest, planTask } from '../../extension/lib/ai/core.js';
import { detectKeyType } from '../../extension/lib/ai/keytype.js';
import { makeWindow, score } from './window.mjs';

const key = (await new Response(process.stdin).text()).trim();
const host = detectKeyType(key) === 'vertex' ? 'https://aiplatform.googleapis.com' : 'https://generativelanguage.googleapis.com';
const config = { provider: 'google', google: { apiKey: key, model: 'gemini-3.5-flash-lite' }, consent: [host] };
const [n = 650, runs = 1, mode = 'auto', size = 80] = process.argv.slice(2).map((v, i) => (i < 2 || i === 3 ? Number(v) : v));
const instruction = 'Group my tabs by topic or task and give each group a short, clear name. Leave one-off tabs ungrouped. Do not close or move anything.';

let requests = 0;
const log = [];
const counting = async (url, init) => {
  requests++;
  const t0 = Date.now();
  const merge = String(init?.body ?? '').includes('Each item is a tab group');
  try {
    const res = await fetch(url, init);
    const text = await res.clone().text();
    let finish = '';
    let out = 0;
    try { const j = JSON.parse(text); finish = j.candidates?.[0]?.finishReason ?? ''; out = j.usageMetadata?.candidatesTokenCount ?? 0; } catch {}
    let groupsOut = null;
    try { const j = JSON.parse(text); const plan = JSON.parse(j.candidates[0].content.parts.map((p) => p.text).join('')); groupsOut = (plan.actions ?? []).filter((a) => a.type === 'group').length; } catch {}
    log.push({ merge, ms: Date.now() - t0, status: res.status, finish, outTokens: out, groupsOut, inChars: String(init?.body ?? '').length });
    return res;
  } catch (e) {
    log.push({ merge, ms: Date.now() - t0, error: e.name });
    throw e;
  }
};
const once = async ({ instruction: ins, tabs }) => {
  const request = parsePlanRequest({ instruction: ins, tabs });
  const raw = await createBackend(config, { fetchImpl: counting }).complete(planTask(request));
  const plan = normalizePlan(raw, request.tabs);
  plan.rawMessage = cleanText(raw?.message, 400);
  return plan;
};

for (let r = 0; r < runs; r++) {
  const window = makeWindow(n, process.env.SEED ? Number(process.env.SEED) : 7 + r);
  const tabs = window.map(({ id, title, url }) => ({ id, title, url }));
  requests = 0;
  const started = Date.now();
  try {
    const plan = mode === 'single' ? await once({ instruction, tabs })
      : mode === 'parts' ? await planInParts({ instruction, tabs }, once, { concurrency: 4, size })
        : await planWithAI({ instruction, tabs }, config, { fetchImpl: counting });
    console.log(JSON.stringify({ n, mode, seconds: (Date.now() - started) / 1000, requests, ...score(window, plan.actions), notes: plan.notes }));
    if (process.env.LOG) console.log(JSON.stringify(log.splice(0)));
  } catch (e) {
    console.log(JSON.stringify({ n, mode, error: e.code, message: String(e.message).split(key).join('[key]').slice(0, 160) }));
  }
}
