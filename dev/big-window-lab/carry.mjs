// Prototype: plan the parts one after another. Each part is told the group names planned so far,
// so names stay consistent without a separate combine step. Works through any provider, including
// the optional server, because it only uses the normal planner.
//   security find-generic-password -s decltr -a vertex-api-key -w | node dev/big-window-lab/carry.mjs 650 [part=80]
import { createBackend } from '../../extension/lib/ai/index.js';
import { normalizePlan, parsePlanRequest, planTask } from '../../extension/lib/ai/core.js';
import { detectKeyType } from '../../extension/lib/ai/keytype.js';
import { makeWindow, score } from './window.mjs';

const key = (await new Response(process.stdin).text()).trim();
const host = detectKeyType(key) === 'vertex' ? 'https://aiplatform.googleapis.com' : 'https://generativelanguage.googleapis.com';
const backend = createBackend({ provider: 'google', google: { apiKey: key, model: 'gemini-3.5-flash-lite' }, consent: [host] });
const N = Number(process.argv[2] ?? 650);
const PART = Number(process.argv[3] ?? 80);
const instruction = 'Group my tabs by topic or task and give each group a short, clear name. Leave one-off tabs ungrouped. Do not close or move anything.';
const window = makeWindow(N);
const started = Date.now();
let requests = 0;
let retried = 0;
const groups = new Map(); // lower-case name -> { name, tabIds }
for (let k = 0; k < window.length; k += PART) {
  const tabs = window.slice(k, k + PART).map(({ id, title, url }) => ({ id, title, url }));
  const names = [...groups.values()].map((g) => g.name);
  const note = `\n\nThis is part ${k / PART + 1} of ${Math.ceil(window.length / PART)} of one large window. Put every tab that fits a topic into a group, even when it is the only tab of that topic in this part.` +
    (names.length ? ` Groups already planned for earlier parts: ${names.join('; ')}. When tabs fit one of these, use that exact name.` : '');
  let request;
  let raw;
  for (let attempt = 0; ; attempt++) {
    request = parsePlanRequest({ instruction: instruction + note, tabs: attempt % 2 ? [...tabs].reverse() : tabs });
    try {
      requests++;
      raw = await backend.complete(planTask(request));
      break;
    } catch (e) {
      if (attempt >= 2 || !['empty_response', 'rate_limited', 'upstream_timeout', 'timeout', 'bad_response'].includes(e.code)) throw e;
      retried++;
    }
  }
  for (const a of normalizePlan(raw, request.tabs).actions) {
    if (a.type !== 'group') continue;
    const key = a.name.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: a.name, tabIds: [] });
    groups.get(key).tabIds.push(...a.tabIds);
  }
}
const actions = [...groups.values()].filter((g) => g.tabIds.length >= 2).map((g) => ({ type: 'group', ...g }));
console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, requests, retried, instructionChars: (instruction.length + 400 + [...groups.values()].map((g) => g.name).join('; ').length), groups: actions.length, names: actions.map((a) => `${a.name} (${a.tabIds.length})`), ...score(window, actions) }, null, 1));
