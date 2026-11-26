// Big windows and big sessions: opening lightly, planning in parts, archiving old tabs, opening part of a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import { openTabsLightly, weakTitle, LIGHT_OPEN_FROM } from '../extension/lib/light-open.js';
import {
  buildSession, keepKnownDetails, knowsLastUse, loadSessions, openSession, partOfSession, pickByGroups, pickByLastUse, saveSession, undoOpen,
} from '../extension/lib/sessions.js';
import { openTracked } from '../extension/lib/session-ops.js';
import { createTracker, getLinks, syncWindow } from '../extension/lib/tracker.js';
import { applyPlan, describeResult, tabsToReopen, undoPlan } from '../extension/lib/actions.js';
import { ago, archiveName, countByAge, DAY, planArchive, staleTabs } from '../extension/lib/archive.js';
import { sanitizePlan, describeActions } from '../extension/lib/plan.js';
import { planInParts, splitIntoParts, SINGLE_PLAN_MAX } from '../extension/lib/ai/parts.js';
import { planWithAI } from '../extension/lib/ai/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { titleWaitMs: 60, commitWaitMs: 200, pollMs: 2 };
const urlsOf = (n, host = 'site') => Array.from({ length: n }, (_, i) => `https://${host}${i % 7}.example/page/${i}`);

function install(opts = {}) {
  globalThis.chrome = createMockChrome({ tabs: [{ id: 1, url: 'https://keep.example/', title: 'Keep', active: true }], loading: { commitMs: 3, titleMs: 8 }, ...opts });
  return globalThis.chrome;
}
const windowTabs = (windowId) => chrome.tabs.query({ windowId });

// ---- opening lightly ---------------------------------------------------------------

test('weak titles: an address shown as the title is recognised, a real title is not', () => {
  assert.equal(weakTitle('', 'https://a.com/x'), true);
  assert.equal(weakTitle('a.com/x', 'https://a.com/x'), true);
  assert.equal(weakTitle('https://a.com/x/', 'https://a.com/x'), true);
  assert.equal(weakTitle('The A page', 'https://a.com/x'), false);
});

test('a few tabs simply load; many tabs open unloaded once their address and title are known, with new IDs', async () => {
  install();
  const small = await openTabsLightly(urlsOf(5).map((url) => ({ url })), { windowId: 1, ...FAST });
  assert.equal(chrome.__state.discards ?? 0, 0, 'below the threshold nothing is unloaded');
  assert.equal(small.unloaded, 0);

  const urls = urlsOf(LIGHT_OPEN_FROM + 14, 'big');
  const created = [];
  const big = await openTabsLightly(urls.map((url) => ({ url })), { windowId: 1, ...FAST, onCreated: (i, id) => created.push(id) });
  const tabs = await windowTabs(1);
  const opened = tabs.filter((t) => t.url.includes('big'));
  assert.deepEqual(opened.map((t) => t.url), urls, 'every tab is there, in order, with its address');
  assert.ok(opened.every((t) => t.discarded), 'all unloaded');
  assert.ok(opened.every((t) => t.title.startsWith('Title of')), 'each kept its real title');
  assert.deepEqual(big.ids, opened.map((t) => t.id), 'the returned IDs are the ones the tabs have now');
  assert.ok(big.ids.every((id, i) => id !== created[i]), 'unloading gave every tab a new ID');
  assert.equal(big.unloaded, urls.length);
});

test('only a few tabs load at the same time', async () => {
  install({ loading: { commitMs: 4, titleMs: 15 } });
  let loading = 0;
  let most = 0;
  const realCreate = chrome.tabs.create;
  const realDiscard = chrome.tabs.discard;
  chrome.tabs.create = async (p) => { loading++; most = Math.max(most, loading); return realCreate(p); };
  chrome.tabs.discard = async (id) => { loading--; return realDiscard(id); };
  await openTabsLightly(urlsOf(40).map((url) => ({ url })), { windowId: 1, concurrency: 4, ...FAST });
  assert.ok(most <= 4, `at most 4 loading at once, saw ${most}`);
});

test('pinned tabs and the tab you land on stay loaded; a stalled page is left loading rather than losing its address', async () => {
  install({ loading: { commitMs: 3, titleMs: 8 } });
  const specs = urlsOf(20).map((url, i) => ({ url, pinned: i === 3 }));
  const { ids } = await openTabsLightly(specs, { windowId: 1, keepLoaded: (i) => i === 0, ...FAST });
  const byId = new Map((await windowTabs(1)).map((t) => [t.id, t]));
  assert.equal(byId.get(ids[0]).discarded, false, 'the first tab stays loaded');
  assert.equal(byId.get(ids[3]).discarded, false, 'pinned tabs stay loaded, since they only show an icon');
  assert.equal(byId.get(ids[5]).discarded, true);

  install({ loading: { commitMs: 10_000 } }); // the address never arrives in time
  const stalled = await openTabsLightly(urlsOf(16).map((url) => ({ url })), { windowId: 1, ...FAST });
  const tabs = await windowTabs(1);
  assert.equal(stalled.unloaded, 0);
  assert.ok(tabs.filter((t) => t.pendingUrl).length === 16 && tabs.every((t) => !t.discarded), 'never unloaded before its address is known');
});

test('a page that never sends a title is unloaded with its address; stopping keeps what was opened', async () => {
  install({ loading: { commitMs: 2, titleMs: Infinity } });
  const r = await openTabsLightly(urlsOf(16).map((url) => ({ url })), { windowId: 1, ...FAST });
  const tabs = (await windowTabs(1)).slice(1);
  assert.equal(r.unloaded, 16);
  assert.ok(tabs.every((t) => t.url.startsWith('https://') && weakTitle(t.title, t.url)), 'address kept, title is the address');

  install();
  const stop = new AbortController();
  const half = await openTabsLightly(urlsOf(30).map((url) => ({ url })), { windowId: 1, ...FAST, onCreated: (i) => i === 9 && stop.abort(), signal: stop.signal });
  assert.equal(half.stopped, true);
  assert.equal(half.ids.filter(Boolean).length, 10);
  assert.equal((await windowTabs(1)).length, 11);
});

// ---- big sessions ------------------------------------------------------------------

function bigSession(n = 40) {
  const groups = new Map([[7, { title: 'Trip', color: 'green', collapsed: true }], [8, { title: 'Work', color: 'blue', collapsed: false }]]);
  const now = Date.now();
  return buildSession({
    name: 'Huge',
    tabs: urlsOf(n).map((url, i) => ({ id: i + 1, url, title: `Saved title ${i}`, favIconUrl: `https://icons.example/${i}.png`, groupId: i < 10 ? 7 : i < 25 ? 8 : -1, lastAccessed: now - i * DAY })),
    groups,
  });
}

test('a big session opens lightly with its groups, the first tab active and loaded, and undo closes it all', async () => {
  install();
  const session = bigSession(40);
  const info = await openSession(session, { target: 'new', windowId: 1, ...FAST });
  const tabs = await windowTabs(info.windowId);
  assert.equal(tabs.length, 40, 'the blank tab of the new window was replaced');
  assert.deepEqual(tabs.map((t) => t.url), session.tabs.map((t) => t.url));
  assert.deepEqual(info.createdIds, tabs.map((t) => t.id), 'IDs are the final ones');
  const groups = await chrome.tabGroups.query({ windowId: info.windowId });
  const trip = groups.find((g) => g.title === 'Trip');
  const work = groups.find((g) => g.title === 'Work');
  assert.equal(tabs.filter((t) => t.groupId === trip.id).length, 10);
  assert.equal(tabs.filter((t) => t.groupId === work.id).length, 15);
  assert.equal(trip.collapsed, false, 'the group holding the active tab cannot be collapsed');
  assert.equal(tabs[0].active, true);
  assert.equal(tabs[0].discarded, false);
  assert.equal(tabs.filter((t) => t.discarded).length, 39);
  assert.equal(info.unloaded, 39);

  await undoOpen(info);
  assert.equal(chrome.__state.windows.has(info.windowId), false, 'undo closes the window it opened');
});

test('undoing a big close reopens the tabs lightly, in place and in their groups', async () => {
  const seed = [{ id: 1, url: 'https://keep.example/', title: 'Keep', active: true }];
  urlsOf(30).forEach((url, i) => seed.push({ id: 100 + i, url, title: `T${i}`, groupId: i < 12 ? 5 : -1 }));
  globalThis.chrome = createMockChrome({ tabs: seed, groups: [{ id: 5, title: 'Reading', color: 'pink' }], loading: { commitMs: 2, titleMs: 5 } });
  const before = (await windowTabs(1)).map((t) => t.url);
  const ids = seed.slice(1).map((t) => t.id);
  const result = await applyPlan({ actions: [{ type: 'close', tabIds: ids }] }, { windowId: 1 });
  assert.equal(tabsToReopen(result.undo), 30);
  const progress = [];
  await undoPlan(result.undo, { onProgress: (p) => progress.push(p.done) });
  const tabs = await windowTabs(1);
  assert.deepEqual(tabs.map((t) => t.url), before, 'every tab back where it was');
  assert.ok(tabs.filter((t) => t.discarded).length >= 29, 'reopened without loading');
  const reading = (await chrome.tabGroups.query({ windowId: 1 })).find((g) => g.title === 'Reading');
  assert.equal(tabs.filter((t) => t.groupId === reading.id).length, 12, 'the group is rebuilt with the new IDs');
  assert.equal(progress.at(-1), 30);
});

test('live syncing keeps the titles, icons and last-used times that unloaded tabs no longer show', async () => {
  install();
  const tracker = createTracker({ debounceMs: 5 });
  tracker.register();
  const session = bigSession(20);
  await saveSession(session);
  const info = await openTracked(session, { target: 'new', windowId: 1 });
  assert.equal(info.tracking, true);
  // Chrome unloads a tab before its title came, and another page's title really changes.
  const tabs = await windowTabs(info.windowId);
  chrome.__setTab(tabs[4].id, { title: tabs[4].url.replace('https://', ''), favIconUrl: '' });
  chrome.__setTab(tabs[6].id, { title: 'A brand new title' });
  await sleep(30);
  await tracker.flush();
  const saved = (await loadSessions()).find((s) => s.id === session.id);
  assert.equal(saved.tabs[4].title, 'Saved title 4');
  assert.equal(saved.tabs[4].favIcon, 'https://icons.example/4.png');
  assert.equal(saved.tabs[6].title, 'A brand new title', 'real changes are still saved');
  assert.ok(saved.tabs.every((t) => t.used), 'last-used times survive');
});

test('keepKnownDetails only fills in what is missing', () => {
  const known = [{ url: 'https://a.com/', title: 'A', favIcon: 'https://a.com/i.png', used: 5 }];
  assert.deepEqual(keepKnownDetails([{ url: 'https://a.com/', title: 'a.com', favIcon: '', g: -1 }], known), [{ url: 'https://a.com/', title: 'A', favIcon: 'https://a.com/i.png', used: 5, g: -1 }]);
  assert.deepEqual(keepKnownDetails([{ url: 'https://a.com/', title: 'New', favIcon: 'https://a.com/n.png', used: 9 }], known), [{ url: 'https://a.com/', title: 'New', favIcon: 'https://a.com/n.png', used: 9 }]);
  assert.deepEqual(keepKnownDetails([{ url: 'https://b.com/', title: 'b.com' }], known), [{ url: 'https://b.com/', title: 'b.com' }]);
});

// ---- opening part of a session -----------------------------------------------------

test('picking part of a session: by group, most recent, oldest; groups are renumbered', () => {
  const s = bigSession(40); // tab i was last used i days ago; tabs 0-9 Trip, 10-24 Work
  assert.equal(knowsLastUse(s), true);
  assert.deepEqual(pickByLastUse(s, { count: 3, newest: true }), [0, 1, 2]);
  assert.deepEqual(pickByLastUse(s, { count: 3, newest: false }), [37, 38, 39]);
  assert.deepEqual(pickByGroups(s, [1]), Array.from({ length: 15 }, (_, i) => i + 10));
  assert.equal(pickByGroups(s, [-1]).length, 15, '-1 picks the ungrouped tabs');
  const part = partOfSession(s, pickByGroups(s, [1, -1]));
  assert.equal(part.tabs.length, 30);
  assert.deepEqual(part.groups.map((g) => g.title), ['Work']);
  assert.ok(part.tabs.filter((t) => t.g === 0).length === 15 && part.tabs.filter((t) => t.g === -1).length === 15);
  assert.equal(s.tabs.length, 40, 'the saved session itself is not changed');
  assert.equal(knowsLastUse({ tabs: [{ url: 'https://a.com/' }] }), false);
});

test('an opened part is never kept in sync, and neither is an open that was stopped', async () => {
  install();
  const s = bigSession(20);
  await saveSession(s);
  const part = await openTracked(s, { target: 'new', windowId: 1, positions: pickByGroups(s, [0]) });
  assert.equal(part.partial, true);
  assert.equal(part.tracking, false);
  assert.equal((await windowTabs(part.windowId)).length, 10);
  assert.deepEqual(await getLinks(), {});
  assert.equal(await syncWindow(part.windowId), 'not-linked');

  const stop = new AbortController();
  stop.abort();
  const stopped = await openTracked(s, { target: 'new', windowId: 1, signal: stop.signal });
  assert.equal(stopped.tracking, false);
  assert.deepEqual(await getLinks(), {});

  const whole = await openTracked(s, { target: 'new', windowId: 1, positions: s.tabs.map((_, i) => i) });
  assert.equal(whole.partial, false, 'picking every tab is a normal open');
  assert.equal(whole.tracking, true);
});

// ---- archiving old tabs --------------------------------------------------------------

function staleWindow(now) {
  const ages = [0, 2, 8, 9, 20, 40, 100, 200]; // days since each tab was last used
  const tabs = [{ id: 1, url: 'https://now.example/', title: 'Now', active: true, lastAccessed: now }];
  ages.forEach((d, i) => tabs.push({ id: 10 + i, url: `https://old${i}.example/`, title: `Used ${d} days ago`, lastAccessed: now - d * DAY - 1000, groupId: i < 3 ? 4 : -1 }));
  tabs.push({ id: 30, url: 'https://music.example/', title: 'Playing', audible: true, lastAccessed: now - 300 * DAY });
  tabs.push({ id: 31, url: 'chrome://newtab/', title: 'New Tab', lastAccessed: now - 300 * DAY });
  tabs.push({ id: 32, url: 'https://unknown.example/', title: 'Unknown age' });
  return tabs;
}

test('stale tabs: never the current tab, a playing tab, a blank tab, or one whose age is unknown', () => {
  const now = Date.UTC(2026, 10, 26);
  const tabs = staleWindow(now);
  assert.deepEqual(staleTabs(tabs, { days: 7, now }).map((t) => t.title), ['Used 200 days ago', 'Used 100 days ago', 'Used 40 days ago', 'Used 20 days ago', 'Used 9 days ago', 'Used 8 days ago']);
  assert.deepEqual(countByAge(tabs, now).map((a) => [a.label, a.count]), [['1 week', 6], ['2 weeks', 4], ['1 month', 3], ['3 months', 2], ['6 months', 1]]);
  assert.match(archiveName(14, now), /^Not used since /);
  assert.equal(ago(now - 3 * 7 * DAY, now), '3 weeks ago');
  assert.equal(ago(now - 90 * 1000, now), '1 minute ago');
  assert.match(planArchive(tabs, { days: 365, now }).message, /Nothing to archive/);
  assert.match(planArchive([{ id: 1, url: 'https://a.example/' }], { days: 7 }).message, /Chrome 121/);
});

test('archiving saves the tabs as an archive session and closes them; undo reopens them and removes the session', async () => {
  const now = Date.now();
  globalThis.chrome = createMockChrome({ tabs: staleWindow(now), groups: [{ id: 4, title: 'Old project', color: 'cyan' }] });
  const snapTabs = (await windowTabs(1)).map((t) => ({ ...t }));
  const plan = sanitizePlan(planArchive(snapTabs, { days: 7, now }), new Map(snapTabs.map((t) => [t.id, t])));
  assert.equal(plan.actions[0].type, 'archive');
  assert.equal(describeActions(plan.actions), 'Archive 6 tabs');

  const result = await applyPlan(plan, { windowId: 1 });
  assert.equal(describeResult(result), 'Archived 6 tabs.');
  const [archive] = await loadSessions();
  assert.equal(archive.kind, 'archive');
  assert.equal(archive.tabs.length, 6);
  assert.equal(archive.groups[0]?.title, 'Old project', 'groups are kept');
  assert.ok(archive.tabs.every((t) => t.used), 'with when each tab was last used');
  const left = await windowTabs(1);
  assert.equal(left.length, snapTabs.length - 6);
  assert.ok(left.some((t) => t.title === 'Now') && left.some((t) => t.title === 'Playing'));

  await undoPlan(result.undo);
  assert.equal((await windowTabs(1)).length, snapTabs.length, 'every tab is back');
  assert.equal((await loadSessions()).length, 0, 'and the archive is gone');
});

test('a tab that became the current tab since the plan was made is not archived', async () => {
  const now = Date.now();
  globalThis.chrome = createMockChrome({ tabs: staleWindow(now) });
  const tabs = await windowTabs(1);
  const plan = planArchive(tabs, { days: 7, now });
  await chrome.tabs.update(15, { active: true }); // "Used 40 days ago" is being looked at now
  const result = await applyPlan(plan, { windowId: 1 });
  assert.equal(result.stats.archived, 5);
  assert.ok((await windowTabs(1)).some((t) => t.id === 15));
});

// ---- planning big windows in parts -------------------------------------------------

const apiTabs = (n, topic = (i) => ['trip', 'code', 'food', 'news'][i % 4]) =>
  Array.from({ length: n }, (_, i) => ({ id: 1000 + i, title: `${topic(i)} page ${i}`, url: `https://${topic(i)}.example/${i}` }));

test('a window is cut into balanced parts; copies of a page and existing groups stay together', () => {
  const tabs = apiTabs(170);
  const parts = splitIntoParts(tabs, 80);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length >= 50 && p.length <= 60), parts.map((p) => p.length).join(','));
  assert.equal(parts.flat().length, 170);

  const dupes = [...apiTabs(100), { id: 1, title: 'again', url: 'https://trip.example/0?utm_source=x' }, { id: 2, title: 'again', url: 'https://trip.example/0' }];
  const withGroup = dupes.map((t, i) => (i >= 40 && i < 70 ? { ...t, group: 'Reading' } : t));
  const cut = splitIntoParts(withGroup, 60);
  const partOf = (id) => cut.findIndex((p) => p.some((t) => t.id === id));
  assert.equal(partOf(1), partOf(1000), 'copies of the same page share a part');
  assert.equal(partOf(2), partOf(1000));
  assert.equal(new Set(withGroup.filter((t) => t.group).map((t) => partOf(t.id))).size, 1, 'a group is not split');

  const huge = splitIntoParts(apiTabs(200).map((t) => ({ ...t, group: 'One big group' })), 80);
  assert.ok(huge.every((p) => p.length <= 80), 'a group bigger than a part is split after all');
});

/** A fake planner: groups part tabs by the topic word in their title, with names that differ by part. */
function fakePlanner({ fail = () => null } = {}) {
  const calls = [];
  const planOnce = async ({ instruction, tabs }) => {
    calls.push({ instruction, tabs });
    const failure = fail(calls.length, { instruction, tabs });
    if (failure) throw failure;
    if (instruction.startsWith('Each item is a tab group')) {
      // Merge items whose names share their first word.
      const byWord = new Map();
      for (const t of tabs) {
        const word = t.title.split(/\W/)[0].toLowerCase();
        if (!byWord.has(word)) byWord.set(word, []);
        byWord.get(word).push(t.id);
      }
      return { summary: '', message: '', actions: [...byWord].filter(([, ids]) => ids.length > 1).map(([w, ids]) => ({ type: 'group', name: `${w[0].toUpperCase()}${w.slice(1)}`, color: 'blue', tabIds: ids })) };
    }
    const part = Number(/part (\d+) of/.exec(instruction)?.[1] ?? 0);
    const byTopic = new Map();
    for (const t of tabs) {
      const topic = t.title.split(' ')[0];
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic).push(t.id);
    }
    const actions = [...byTopic].map(([topic, ids]) => ({ type: 'group', name: part % 2 ? `${topic} things` : `${topic} stuff`, color: 'red', tabIds: ids }));
    actions.push({ type: 'close', tabIds: [tabs[0].id], reason: 'Looks finished' });
    return { summary: '', message: '', actions };
  };
  return { calls, planOnce };
}

test('parts are planned, then groups that mean the same thing are merged across parts', async () => {
  const tabs = apiTabs(250);
  const { calls, planOnce } = fakePlanner();
  const progress = [];
  const plan = await planInParts({ instruction: 'Group by topic', tabs }, planOnce, { onProgress: (p) => progress.push(p.stage), waitScale: 0 });
  const groups = plan.actions.filter((a) => a.type === 'group');
  assert.deepEqual(groups.map((g) => g.name).sort(), ['Code', 'Food', 'News', 'Trip']);
  assert.ok(groups.every((g) => g.tabIds.length >= 60), 'each topic became one group across all parts');
  assert.equal(new Set(groups.map((g) => g.color)).size, 4, 'each group has its own color');
  assert.equal(plan.actions.at(-1).type, 'close', 'closing comes last');
  assert.equal(plan.actions.filter((a) => a.type === 'close').length, 1, 'closes from every part are one action');
  assert.match(plan.notes[0], /Planned in 4 parts/);
  assert.ok(calls.slice(0, 4).every((c) => /part \d of 4/.test(c.instruction) && c.instruction.startsWith('Group by topic')));
  assert.deepEqual([...new Set(progress)], ['parts', 'merge']);
});

test('a part that keeps failing is skipped and reported; a fatal error stops everything', async () => {
  const tabs = apiTabs(250);
  const flaky = fakePlanner({ fail: (n, req) => (/part 2 of/.test(req.instruction) ? Object.assign(new Error('Gemini rate limit reached.'), { code: 'rate_limited' }) : null) });
  const plan = await planInParts({ instruction: 'Group by topic', tabs }, flaky.planOnce, { waitScale: 0 });
  assert.ok(plan.actions.length > 0);
  assert.ok(plan.notes.some((n) => /could not be planned \(Gemini rate limit reached\)/.test(n)), plan.notes.join(' | '));
  assert.equal(flaky.calls.filter((c) => /part 2 of/.test(c.instruction)).length, 4, 'tried four times');
  const retried = flaky.calls.filter((c) => /part 2 of/.test(c.instruction));
  assert.equal(retried[1].tabs[0].id, retried[0].tabs.at(-1).id, 'a retry lists the tabs in another order');

  const broken = fakePlanner({ fail: () => Object.assign(new Error('Google rejected the API key.'), { code: 'bad_key' }) });
  await assert.rejects(planInParts({ instruction: 'x', tabs }, broken.planOnce, { waitScale: 0 }), { code: 'bad_key' });
  assert.ok(broken.calls.length <= 3, 'stops instead of trying every part');
});

test('if merging fails, same-name groups are still combined; a cut-off answer is planned again in halves', async () => {
  const tabs = apiTabs(170);
  const noMerge = fakePlanner({ fail: (n, req) => (req.instruction.startsWith('Each item') ? Object.assign(new Error('x'), { code: 'bad_response' }) : null) });
  const plan = await planInParts({ instruction: 'Group by topic', tabs }, noMerge.planOnce, { waitScale: 0 });
  assert.ok(plan.actions.filter((a) => a.type === 'group').every((g) => /things|stuff/.test(g.name)));

  let cut = 0;
  const trunc = fakePlanner({ fail: (n, req) => (!req.instruction.startsWith('Each item') && req.tabs.length > 60 && cut++ < 1 ? Object.assign(new Error('too big'), { code: 'truncated' }) : null) });
  const halves = await planInParts({ instruction: 'Group by topic', tabs }, trunc.planOnce, { waitScale: 0 });
  const covered = new Set(halves.actions.flatMap((a) => a.tabIds));
  assert.equal(covered.size, 170, 'every tab was still planned');
});

test('stopping a plan in parts stops at once', async () => {
  const stop = new AbortController();
  const { planOnce } = fakePlanner({ fail: (n) => (n === 2 ? (stop.abort(), null) : null) });
  await assert.rejects(planInParts({ instruction: 'x', tabs: apiTabs(400) }, planOnce, { signal: stop.signal, concurrency: 1, waitScale: 0 }), { code: 'aborted' });
});

test('planWithAI plans a big window in parts through a real backend, with every request small', async () => {
  // A scripted Ollama that groups whatever tabs it is sent by the word before " page".
  const sizes = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages.at(-1).content;
    const list = JSON.parse(user.slice(user.indexOf('[')));
    sizes.push(list.length);
    const merge = user.includes('Each item is a tab group');
    const byWord = new Map();
    for (const t of list) {
      const w = t.title.split(/[ ·]/)[0];
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(t.i);
    }
    const actions = [...byWord].map(([w, ids]) => ({ type: 'group', name: merge ? w : `${w} part`, color: 'green', tabIds: ids }));
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ summary: '', actions }) } }), { status: 200 });
  };
  const tabs = apiTabs(SINGLE_PLAN_MAX * 3);
  const plan = await planWithAI({ instruction: 'Group by topic', tabs }, { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'm' } }, { fetchImpl });
  assert.ok(sizes.every((n) => n <= SINGLE_PLAN_MAX), `no request had more than ${SINGLE_PLAN_MAX} tabs: ${sizes}`);
  assert.equal(plan.actions.filter((a) => a.type === 'group').length, 4);
  assert.equal(new Set(plan.actions.flatMap((a) => a.tabIds)).size, tabs.length);
});
