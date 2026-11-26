// Planning a window that has too many tabs for one request.
//
// Measured on a 650-tab test window (dev/big-window-lab): one request with 300 tabs made no plan at all
// (the model answered that there were too many tabs), and one with 100 tabs grouped 62% of them.
// Planning parts of about 80 tabs at the same time, then merging the groups that mean the same thing,
// grouped 93-96% of the tabs, 96-97% of them correctly, in 11-19 seconds.
//
// Both steps use the normal planner, so this works with every model choice, including the optional
// server, and every answer is checked exactly like a single plan.

import { duplicateKey } from '../plan.js';
import { cleanText, COLORS, LIMITS } from './core.js';
import { UpstreamError } from './errors.js';

/** Up to this many tabs are planned in one request, as before. */
export const SINGLE_PLAN_MAX = 80;
/** The size of each part of a bigger window. */
export const PART_SIZE = 80;
const MAX_MERGE_ITEMS = 250; // the merge step is itself a plan, and a plan takes at most 300 "tabs"
const MIN_SPLIT = 12; // a part whose answer was cut off is planned again in two halves, down to this size
const MERGE_PASSES = 3;

// Errors that may go away when the same request is sent again. Anything else (a wrong key, no credit,
// no model chosen, the server not running) would fail for every part, so it stops the whole plan.
const RETRY_WAIT_MS = { rate_limited: [5_000, 15_000, 30_000], busy: [1_000, 2_000, 4_000] };
const TRANSIENT = new Set(['empty_response', 'bad_response', 'timeout', 'upstream_timeout', 'upstream_error', 'error', ...Object.keys(RETRY_WAIT_MS)]);
const DEFAULT_WAIT_MS = [1_500, 4_000];

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(stopped());
    }, { once: true });
  });
const stopped = () => new UpstreamError('aborted', 'Stopped.', 499);

/**
 * Cut the window into parts of about `size` tabs. Copies of the same page always share a part, so
 * "close duplicates" still finds them, and so do the tabs of an existing group, so a request about a
 * group sees all of it. Parts are balanced: 100 tabs become two parts of 50, not 80 and 20.
 */
export function splitIntoParts(tabs, size = PART_SIZE) {
  const units = new Map(); // key -> tabs, in the order the keys first appear
  for (const t of tabs) {
    const key = t.group ? `group:${t.group}` : `page:${duplicateKey(t.url) ?? `tab:${t.id}`}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(t);
  }
  const target = Math.ceil(tabs.length / Math.max(1, Math.ceil(tabs.length / size)));
  const parts = [];
  let current = [];
  for (let unit of units.values()) {
    while (unit.length > target) {
      // A group (or a page open many times) bigger than a whole part is split.
      if (current.length) parts.push(current);
      parts.push(unit.slice(0, target));
      unit = unit.slice(target);
      current = [];
    }
    if (current.length && current.length + unit.length > target) {
      parts.push(current);
      current = [];
    }
    current.push(...unit);
  }
  if (current.length) parts.push(current);
  return parts;
}

const partNote = (k, n) =>
  `\n\n(Decltr: these tabs are part ${k} of ${n} of one large window, planned separately. When grouping, put every tab that fits a topic into a group for that topic, ` +
  'even if it is the only tab of that topic in this part: groups with the same meaning are merged across parts afterwards.)';

/** The user's instruction with the note added, trimmed so that the note always fits. */
function withNote(instruction, note) {
  const room = LIMITS.instruction - note.length;
  return `${instruction.length > room ? `${instruction.slice(0, room - 1)}…` : instruction}${note}`;
}

const MERGE_INSTRUCTION =
  'Each item is a tab group that was planned separately for one part of a large window: its name, how many tabs it holds, and example titles. ' +
  'Group together only the items that are clearly about the same topic, project or task, such as "Lisbon Trip" and "Lisbon Travel", and give each combined group a clear name of 1 to 3 words. ' +
  'Keep related but different topics apart: "Rust" and "React" stay separate, and so do "Taxes" and "Budget". ' +
  'Leave an item on its own when no other item is about the same thing. Do not close or move anything.';

/**
 * Plan a big window in parts, then merge. `planOnce({ instruction, tabs })` must return a checked plan
 * with real tab IDs, the same thing a single request returns. Parts run `concurrency` at a time.
 * `onProgress({ stage: 'parts', done, total })` and `onProgress({ stage: 'merge' })` report progress.
 */
export async function planInParts({ instruction, tabs }, planOnce, { concurrency = 3, onProgress, signal, size = PART_SIZE, waitScale = 1 } = {}) {
  const queue = splitIntoParts(tabs, size).map((partTabs) => ({ tabs: partTabs }));
  const total = queue.length;
  const plans = [];
  const failures = [];
  let done = 0;
  let fatal = null;
  onProgress?.({ stage: 'parts', done, total });

  async function planPart(part, number) {
    const waits = (code) => RETRY_WAIT_MS[code] ?? DEFAULT_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw stopped();
      // Each try lists the tabs in a different order: Gemini sometimes cuts off an answer that is mostly a long
      // list of numbers, calling it recitation, and the same request in a new order usually goes through.
      const ordered = attempt % 2 ? [...part.tabs].reverse() : part.tabs;
      try {
        return await planOnce({ instruction: withNote(instruction, partNote(number, total)), tabs: ordered });
      } catch (err) {
        if (err?.code === 'aborted' || signal?.aborted) throw stopped();
        if (err?.code === 'truncated' && part.tabs.length >= MIN_SPLIT * 2) return { split: true };
        if (!TRANSIENT.has(err?.code) || attempt >= waits(err.code).length) throw err;
        await sleep(waits(err.code)[attempt] * waitScale, signal);
      }
    }
  }

  let next = 0;
  async function worker() {
    while (next < queue.length && !fatal) {
      const number = next + 1;
      const part = queue[next++];
      try {
        const plan = await planPart(part, Math.min(number, total));
        if (plan.split) {
          const half = Math.ceil(part.tabs.length / 2);
          queue.push({ tabs: part.tabs.slice(0, half) }, { tabs: part.tabs.slice(half) });
          continue;
        }
        plans.push({ plan, tabs: part.tabs });
        done++;
        onProgress?.({ stage: 'parts', done, total });
      } catch (err) {
        if (err?.code === 'aborted') {
          fatal = err;
        } else if (TRANSIENT.has(err?.code) || err?.code === 'truncated') {
          failures.push({ tabs: part.tabs, error: err });
          done++;
          onProgress?.({ stage: 'parts', done, total });
        } else {
          fatal = err;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  if (fatal) throw fatal;
  if (plans.length === 0) throw failures[0]?.error ?? new UpstreamError('empty_response', 'The model did not answer. Try again.');

  // ---- combine the parts ------------------------------------------------------
  const order = new Map(tabs.map((t, i) => [t.id, i]));
  const firstIndex = (ids) => Math.min(...ids.map((id) => order.get(id) ?? Infinity));
  const ofType = (type) => plans.flatMap(({ plan }) => plan.actions.filter((a) => a.type === type));
  const union = (actions) => [...new Set(actions.flatMap((a) => a.tabIds))];

  const groups = await mergeGroups(ofType('group'), { planOnce, onProgress, signal, tabs });
  const actions = [];
  const ungroup = union(ofType('ungroup'));
  if (ungroup.length) actions.push({ type: 'ungroup', tabIds: ungroup });
  actions.push(...groups.sort((a, b) => firstIndex(a.tabIds) - firstIndex(b.tabIds)));
  const move = union(ofType('move_to_new_window'));
  if (move.length) actions.push({ type: 'move_to_new_window', tabIds: move, ...firstReason(ofType('move_to_new_window')) });
  const folders = new Map();
  for (const a of ofType('bookmark')) {
    const key = a.folder.trim().toLowerCase();
    if (!folders.has(key)) folders.set(key, { type: 'bookmark', folder: a.folder, tabIds: [] });
    folders.get(key).tabIds.push(...a.tabIds.filter((id) => !folders.get(key).tabIds.includes(id)));
  }
  actions.push(...folders.values());
  const close = union(ofType('close'));
  if (close.length) actions.push({ type: 'close', tabIds: close, ...firstReason(ofType('close')) });

  const notes = [`Planned in ${plans.length + failures.length} parts, because this window has ${tabs.length} tabs.`];
  const failedTabs = failures.reduce((n, f) => n + f.tabs.length, 0);
  if (failedTabs) notes.push(`${failedTabs} tabs could not be planned (${failures[0].error.message.replace(/\.$/, '')}), so they stay as they are.`);
  if (groups.length) {
    const touched = new Set(actions.flatMap((a) => a.tabIds));
    const left = tabs.length - failedTabs - touched.size;
    if (left > 0) notes.push(`${left} tab${left === 1 ? '' : 's'} did not fit a group and stay where ${left === 1 ? 'it is' : 'they are'}.`);
  }
  const message = actions.length ? '' : plans.map(({ plan }) => plan.message || plan.rawMessage).find(Boolean) ?? '';
  return { summary: '', message, actions, notes };
}

function firstReason(actions) {
  const reason = actions.map((a) => a.reason).find(Boolean);
  return reason ? { reason } : {};
}

/**
 * Groups from different parts that mean the same thing become one. Exact name matches merge right away;
 * the rest is decided by the model in one more plan, where each "tab" is one proposed group. If that step
 * fails, the exact-name merge is kept. Groups that end up with one tab are dropped, as in a single plan.
 */
async function mergeGroups(proposed, { planOnce, onProgress, signal, tabs }) {
  const byName = new Map();
  for (const g of proposed) {
    const key = g.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: g.name, colors: [], tabIds: [] });
    const entry = byName.get(key);
    entry.colors.push(g.color);
    for (const id of g.tabIds) if (!entry.tabIds.includes(id)) entry.tabIds.push(id);
  }
  let merged = [...byName.values()];
  const titleOf = new Map(tabs.map((t) => [t.id, t.title]));
  // The model merges some of a long list each time and leaves the rest, so merging runs in passes until a
  // pass combines nothing. Each pass lists the groups in another order.
  for (let pass = 0; pass < MERGE_PASSES && merged.length > 1 && merged.length <= MAX_MERGE_ITEMS; pass++) {
    onProgress?.({ stage: 'merge', pass: pass + 1 });
    const items = merged.map((g, k) => ({
      id: k + 1,
      title: cleanText(`${g.name} · ${g.tabIds.length} tab${g.tabIds.length === 1 ? '' : 's'} · ${g.tabIds.slice(0, 2).map((id) => cleanText(titleOf.get(id), 45)).join('; ')}`, LIMITS.title),
      url: '',
    }));
    let combined;
    try {
      if (signal?.aborted) throw stopped();
      const plan = await planOnce({ instruction: MERGE_INSTRUCTION, tabs: pass % 2 ? [...items].reverse() : items });
      const used = new Set();
      combined = [];
      for (const a of plan.actions) {
        if (a.type !== 'group') continue;
        const members = a.tabIds.filter((n) => !used.has(n) && n >= 1 && n <= merged.length);
        if (members.length === 0) continue;
        members.forEach((n) => used.add(n));
        const parts = members.map((n) => merged[n - 1]);
        // A group of one item keeps its own name: the model only renames what it actually merges.
        combined.push(members.length === 1 ? parts[0] : { name: a.name, colors: parts.flatMap((p) => p.colors), tabIds: [...new Set(parts.flatMap((p) => p.tabIds))] });
      }
      merged.forEach((g, k) => used.has(k + 1) || combined.push(g));
    } catch (err) {
      if (err?.code === 'aborted') throw err;
      break; // keep what has been merged so far
    }
    const before = merged.length;
    merged = combined;
    if (merged.length === before) break;
  }
  const taken = new Set();
  return merged
    .filter((g) => g.tabIds.length >= 2)
    .sort((a, b) => b.tabIds.length - a.tabIds.length) // bigger groups pick their color first
    .map((g) => {
      const wanted = [...g.colors, ...COLORS.filter((c) => c !== 'grey'), 'grey'].find((c) => c && !taken.has(c)) ?? g.colors[0] ?? 'grey';
      taken.add(wanted);
      if (taken.size >= COLORS.length) taken.clear(); // more groups than colors: start reusing them
      return { type: 'group', name: cleanText(g.name, LIMITS.groupName) || 'Group', color: wanted, tabIds: g.tabIds };
    });
}
