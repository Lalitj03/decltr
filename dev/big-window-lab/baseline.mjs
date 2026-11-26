// Today's one-shot planning on big windows. The key is read from stdin and never printed:
//   security find-generic-password -s decltr -a vertex-api-key -w | node dev/big-window-lab/baseline.mjs 300
import { planWithAI } from '../../extension/lib/ai/index.js';
import { detectKeyType } from '../../extension/lib/ai/keytype.js';
import { makeWindow, score } from './window.mjs';

const key = (await new Response(process.stdin).text()).trim();
const host = detectKeyType(key) === 'vertex' ? 'https://aiplatform.googleapis.com' : 'https://generativelanguage.googleapis.com';
const config = { provider: 'google', google: { apiKey: key, model: 'gemini-3.5-flash-lite' }, consent: [host] };
const instruction = 'Group my tabs by topic or task and give each group a short, clear name. Leave one-off tabs ungrouped. Do not close or move anything.';

for (const n of process.argv.slice(2).map(Number)) {
  const window = makeWindow(n);
  const sent = window.slice(0, 300); // the panel sends at most 300 tabs today
  const started = Date.now();
  try {
    const plan = await planWithAI({ instruction, tabs: sent.map(({ id, title, url }) => ({ id, title, url })) }, config);
    const s = score(window, plan.actions);
    console.log(JSON.stringify({ windowTabs: n, sentTabs: sent.length, seconds: (Date.now() - started) / 1000, ...s }));
  } catch (e) {
    console.log(JSON.stringify({ windowTabs: n, error: e.code, message: String(e.message).split(key).join('[key]').slice(0, 160) }));
  }
}
