// What the model really returned for one big window, before validation. Key from stdin.
import { createBackend } from '../../extension/lib/ai/index.js';
import { parsePlanRequest, planTask } from '../../extension/lib/ai/core.js';
import { detectKeyType } from '../../extension/lib/ai/keytype.js';
import { makeWindow } from './window.mjs';
const key = (await new Response(process.stdin).text()).trim();
const host = detectKeyType(key) === 'vertex' ? 'https://aiplatform.googleapis.com' : 'https://generativelanguage.googleapis.com';
const config = { provider: 'google', google: { apiKey: key, model: 'gemini-3.5-flash-lite' }, consent: [host] };
const n = Number(process.argv[2] ?? 300);
const window = makeWindow(n).slice(0, 300);
const request = parsePlanRequest({ instruction: 'Group my tabs by topic or task and give each group a short, clear name. Leave one-off tabs ungrouped. Do not close or move anything.', tabs: window.map(({ id, title, url }) => ({ id, title, url })) });
const task = planTask(request);
console.log('prompt chars', task.userParts.join('').length);
const raw = await createBackend(config).complete(task);
const ids = (raw.actions ?? []).flatMap((a) => a.tabIds ?? []);
console.log(JSON.stringify({ summary: raw.summary, message: raw.message, actions: (raw.actions ?? []).length, ids: ids.length, minId: Math.min(...ids), maxId: Math.max(...ids), first: (raw.actions ?? []).slice(0, 2) }).slice(0, 900));
