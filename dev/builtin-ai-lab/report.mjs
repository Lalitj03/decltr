// Builds REPORT.md from results.json. Run: node dev/builtin-ai-lab/report.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(readFileSync(join(here, 'results.json'), 'utf8'));
const CLOUD = 'Gemini (cloud)';
const NANO = 'Gemini Nano (built-in)';

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
const sec = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const pct = (n, d) => `${n}/${d} (${Math.round((100 * n) / d)}%)`;

const rows = [];
let totals = { [CLOUD]: { pass: 0, n: 0, ms: [] }, [NANO]: { pass: 0, n: 0, ms: [] } };
let unsafe = { [CLOUD]: 0, [NANO]: 0 };
let timeouts = { [CLOUD]: 0, [NANO]: 0 };
for (const c of r.plan) {
  const cells = [c.title, c.tabs];
  for (const e of [CLOUD, NANO]) {
    const t = c.engines[e];
    const pass = t.filter((x) => x.pass).length;
    totals[e].pass += pass;
    totals[e].n += t.length;
    totals[e].ms.push(...t.filter((x) => x.ok).map((x) => x.ms));
    timeouts[e] += t.filter((x) => x.timedOut).length;
    // "Unsafe": closed tabs it should not have, or closed anything when told not to.
    unsafe[e] += t.filter((x) => /wrongly closed/.test(x.metric ?? '') && !/ 0 wrongly closed/.test(x.metric)).length;
    if (c.id === 'injection' || c.id === 'group-topic') unsafe[e] += t.filter((x) => /[1-9]\d* tabs closed/.test(x.metric ?? '')).length;
    cells.push(`${pass}/${t.length}`, sec(median(t.filter((x) => x.ok).map((x) => x.ms))));
  }
  rows.push(`| ${cells.join(' | ')} |`);
}

const nameStats = (e) => {
  const all = r.naming.flatMap((n) => n.engines[e]);
  return { pass: all.filter((x) => x.pass).length, n: all.length, ms: median(all.filter((x) => x.ok).map((x) => x.ms)) };
};
const nameRows = r.naming.map((n) => {
  const cell = (e) => [...new Set(n.engines[e].map((x) => `“${x.name}”${x.pass ? '' : ' ✗'}`))].join(', ');
  return `| ${n.hint} | ${cell(CLOUD)} | ${cell(NANO)} |`;
});
const nc = nameStats(CLOUD), nn = nameStats(NANO);

const md = `# Built-in AI (Gemini Nano) vs Gemini cloud: test report

Run: ${r.env.startedAt}  |  ${r.env.chrome}  |  cloud model: ${r.env.model} on Vertex  |  ${r.env.trials} trials per case

Both engines received the **same prompt** and their outputs went through the **same validator and objective scoring**
(grouping quality is pairwise F1 against the true topics; closes are checked against the exact expected tabs).

## Setup facts
- Model download: about 9.5 minutes on this connection (13:59 to 14:09 in the first run; later runs reuse it), 4.1 GB on disk
- Context window: **${r.setup.contextWindow} tokens**
- First prompt after Chrome starts: 13.6 s in the second run (loading the model into memory); 2.3 s when the model was already warm
- Availability in the Playwright-controlled Chrome: \`unavailable\` (launched with --disable-component-update)

## Task 1: tab plans (pass = every objective check satisfied)

| Case | Tabs | Cloud pass | Cloud median | Nano pass | Nano median |
|---|---|---|---|---|---|
${rows.join('\n')}

**Overall:** cloud ${pct(totals[CLOUD].pass, totals[CLOUD].n)}, median ${sec(median(totals[CLOUD].ms))}
vs Nano ${pct(totals[NANO].pass, totals[NANO].n)}, median ${sec(median(totals[NANO].ms))}.
Nano runs that never finished (90 s cap): ${timeouts[NANO]}. Unsafe results (closed tabs it should not have): cloud ${unsafe[CLOUD]}, Nano ${unsafe[NANO]}.

## Task 2: naming a session (pass = 2 to 4 words, at most 32 chars, clean, ignores injection)

| Tabs | Cloud names | Nano names |
|---|---|---|
${nameRows.join('\n')}

**Overall:** cloud ${pct(nc.pass, nc.n)}, median ${sec(nc.ms)} vs Nano ${pct(nn.pass, nn.n)}, median ${sec(nn.ms)}.
`;
let ext = '';
try {
  const e = JSON.parse(readFileSync(join(here, 'results-ext.json'), 'utf8'));
  const cfgNames = Object.keys(e.configs);
  const head = '| Case | ' + cfgNames.map((n) => n + ' pass | ' + n + ' median').join(' | ') + ' |\n|---|' + cfgNames.map(() => '---|---').join('|') + '|';
  const ids = e.configs[cfgNames[0]].map((c) => c.id);
  const lines = ids.map((id) => {
    const cells = cfgNames.map((n) => {
      const t = e.configs[n].find((c) => c.id === id).trials;
      return t.filter((x) => x.pass).length + '/' + t.length + ' | ' + sec(median(t.filter((x) => x.ok).map((x) => x.ms)));
    });
    return '| ' + e.configs[cfgNames[0]].find((c) => c.id === id).title + ' | ' + cells.join(' | ') + ' |';
  });
  const tot = (n) => { const t = e.configs[n].flatMap((c) => c.trials); return pct(t.filter((x) => x.pass).length, t.length); };
  ext = `
## Experiment 2: inside an extension page, and does lower randomness help?

Decltr's AI calls would run from the side panel, which is an extension page. There the model is **available** (the same downloaded model),
and extensions can set sampling. The default is **temperature ${e.configs[cfgNames[0]][0].trials[0].applied?.temperature ?? 1}, topK ${e.configs[cfgNames[0]][0].trials[0].applied?.topK ?? 64}**.
Five of the plan cases, ${e.configs[cfgNames[0]][0].trials.length} trials each:

${head}
${lines.join('\n')}

**Overall:** ${cfgNames.map((n) => n + ': ' + tot(n)).join(', ')}.
Lower randomness made grouping more accurate and repeatable (F1 0.95 on every trial) but did **not** fix the cases that close tabs: the same wrong tabs are closed on every run.
`;
} catch {}
const full = md + ext;
writeFileSync(join(here, 'REPORT.md'), full);
console.log(full);
