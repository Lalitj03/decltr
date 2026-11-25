import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import { applyPlan, undoPlan, describeResult } from '../extension/lib/actions.js';
import {
  describeActions, duplicateKey, planCloseDuplicates, planCloseGroup, planGroupBySite, planSaveSession, planUngroupAll,
  planUngroupGroup, sanitizePlan,
} from '../extension/lib/plan.js';
import { snapshot, toApiTabs } from '../extension/lib/tabs.js';

const SEED = [
  { id: 1, url: 'https://github.com/a/b', title: 'repo', active: true },
  { id: 2, url: 'https://github.com/a/b/issues', title: 'issues' },
  { id: 3, url: 'https://news.example.com/story?utm_source=x', title: 'story' },
  { id: 4, url: 'https://news.example.com/story', title: 'story again' },
  { id: 5, url: 'https://www.youtube.com/watch?v=1', title: 'video', audible: true },
  { id: 6, url: 'https://mail.example.com', title: 'mail', pinned: true },
  { id: 7, url: 'chrome://settings/', title: 'Settings' },
];

function install(opts = {}) {
  globalThis.chrome = createMockChrome({ tabs: SEED, ...opts });
  return globalThis.chrome;
}
// Order, group membership and window of every tab: what undo must restore.
async function signature() {
  const tabs = [...chrome.__state.tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const title = (id) => (id === -1 ? null : `${chrome.__state.groups.get(id).title}/${chrome.__state.groups.get(id).color}/${chrome.__state.groups.get(id).collapsed ? 'collapsed' : 'open'}`);
  return JSON.stringify(tabs.map((t) => [t.url, t.windowId, title(t.groupId), t.pinned]));
}
const live = (ids) => new Map(ids.map((i) => [i, {}]));

test('sanitizePlan drops unknown tabs, bad types and double-claimed tabs', () => {
  const plan = sanitizePlan(
    {
      summary: 'x',
      actions: [
        { type: 'group', name: 'A', color: 'blue', tabIds: [1, 2, 99, 1] },
        { type: 'group', name: 'B', color: 'nope', tabIds: [2, 3] },
        { type: 'delete_everything', tabIds: [1] },
        { type: 'close', tabIds: ['1'] },
        { type: 'bookmark', tabIds: [4] },
        null,
      ],
    },
    live([1, 2, 3, 4]),
  );
  assert.deepEqual(plan.actions, [
    { type: 'group', tabIds: [1, 2], name: 'A', color: 'blue' },
    { type: 'group', tabIds: [3], name: 'B', color: 'grey' },
    { type: 'bookmark', tabIds: [4], folder: 'Saved tabs' },
  ]);
  assert.deepEqual(sanitizePlan('junk', live([1])).actions, []);
});

test('duplicateKey ignores hash, trailing slash and tracking params only', () => {
  assert.equal(duplicateKey('https://a.com/p/?utm_source=x#top'), duplicateKey('https://a.com/p'));
  assert.notEqual(duplicateKey('https://a.com/p?id=1'), duplicateKey('https://a.com/p?id=2'));
  assert.equal(duplicateKey('chrome://settings'), null);
});

test('preset: close duplicates keeps the active tab and skips pinned', async () => {
  const c = install();
  c.__state.tabs.push({ id: 20, windowId: 1, index: 9, url: 'https://github.com/a/b', title: 'dup', pinned: false, active: false, audible: false, groupId: -1 });
  c.__state.tabs.push({ id: 21, windowId: 1, index: 10, url: 'https://mail.example.com', title: 'mail2', pinned: false, active: false, audible: false, groupId: -1 });
  const snap = await snapshot({ includePinned: false });
  const plan = planCloseDuplicates(snap.tabs);
  assert.deepEqual([...plan.actions[0].tabIds].sort((a, b) => a - b), [4, 20]);
  // 3 stays (first of the pair), 1 stays (active), pinned mail is not considered at all.
  assert.ok(!plan.actions[0].tabIds.includes(21));
  assert.equal(planCloseDuplicates([]).actions.length, 0);
});

test('preset: group by site only groups sites with 2+ ungrouped tabs', async () => {
  install();
  const snap = await snapshot();
  const plan = planGroupBySite(snap.tabs);
  assert.deepEqual(plan.actions.map((a) => [a.name, a.tabIds]), [['github.com', [1, 2]], ['news.example.com', [3, 4]]]);
  assert.equal(new Set(plan.actions.map((a) => a.color)).size, 2);
});

test('preset: save session bookmarks then closes only web pages', async () => {
  install();
  const snap = await snapshot();
  const plan = planSaveSession(snap.tabs, new Date(2026, 0, 5, 9, 7));
  assert.equal(plan.actions[0].folder, 'Session 2026-01-05 09:07');
  assert.ok(!plan.actions[1].tabIds.includes(7), 'chrome:// pages are not closed because they cannot be bookmarked');
  assert.deepEqual(plan.actions[0].tabIds, plan.actions[1].tabIds);
});

test('apply group: creates a group, reuses a same-named one, and undo restores everything', async () => {
  install({ groups: [{ id: 50, title: 'Reading', color: 'green' }], tabs: SEED.map((t) => (t.id === 4 ? { ...t, groupId: 50 } : t)) });
  const before = await signature();
  const plan = {
    actions: [
      { type: 'group', name: 'Dev', color: 'blue', tabIds: [1, 2] },
      { type: 'group', name: 'reading', color: 'red', tabIds: [3, 6] }, // pinned 6 is skipped, name matches existing group
    ],
  };
  const res = await applyPlan(plan, { windowId: 1 });
  const groups = await chrome.tabGroups.query({ windowId: 1 });
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.title === 'Dev').color, 'blue');
  const reading = groups.find((g) => g.title === 'Reading');
  assert.deepEqual(chrome.__state.tabs.filter((t) => t.groupId === reading.id).map((t) => t.id).sort(), [3, 4]);
  assert.equal(res.stats.grouped, 3);
  assert.equal(res.stats.skipped, 1);

  await undoPlan(res.undo);
  assert.equal(await signature(), before);
});

test('apply close: leaves a blank tab if everything is closed, and undo reopens in place with groups', async () => {
  install({ groups: [{ id: 50, title: 'Reading', color: 'green' }], tabs: SEED.map((t) => (t.id === 4 ? { ...t, groupId: 50 } : t)) });
  const before = await signature();
  const everything = SEED.map((t) => t.id);
  const res = await applyPlan({ actions: [{ type: 'close', tabIds: everything }] }, { windowId: 1 });
  const left = await chrome.tabs.query({ windowId: 1 });
  assert.equal(left.length, 1, 'window keeps one blank tab');
  assert.equal(left[0].url, 'chrome://newtab/');
  assert.equal(res.stats.closed, 7);
  assert.ok(res.notes.length > 0);

  await undoPlan(res.undo);
  assert.equal(await signature(), before);
  const [g] = await chrome.tabGroups.query({ windowId: 1 });
  assert.equal(g.title, 'Reading', 'group recreated with its title');
});

test('apply close: partial close only removes the requested tabs', async () => {
  install();
  const res = await applyPlan({ actions: [{ type: 'close', tabIds: [3, 999] }] }, { windowId: 1 });
  assert.equal(res.stats.closed, 1);
  assert.equal(res.stats.skipped, 1, 'a tab that no longer exists is skipped, not an error');
  assert.equal((await chrome.tabs.query({ windowId: 1 })).length, 6);
});

test('apply move: new window gets the tabs and keeps groups; undo brings them back', async () => {
  install({ groups: [{ id: 50, title: 'Fun', color: 'pink' }], tabs: SEED.map((t) => (t.id === 3 || t.id === 4 ? { ...t, groupId: 50 } : t)) });
  const before = await signature();
  const res = await applyPlan({ actions: [{ type: 'move_to_new_window', tabIds: [3, 4] }] }, { windowId: 1 });
  assert.equal(res.stats.moved, 2);
  const newTabs = chrome.__state.tabs.filter((t) => t.windowId !== 1);
  assert.deepEqual(newTabs.map((t) => t.id).sort(), [3, 4]);
  assert.ok(newTabs.every((t) => t.groupId !== -1 && chrome.__state.groups.get(t.groupId).title === 'Fun'));

  await undoPlan(res.undo);
  assert.equal(chrome.__state.windows.size, 1, 'emptied window disappears');
  assert.equal(await signature(), before);
});

test('apply move: never moves every tab out of the window', async () => {
  install();
  const res = await applyPlan({ actions: [{ type: 'move_to_new_window', tabIds: SEED.map((t) => t.id) }] }, { windowId: 1 });
  assert.equal(res.stats.moved, 6);
  const remaining = await chrome.tabs.query({ windowId: 1 });
  assert.equal(remaining.length, 1);
  assert.ok(remaining[0].active, 'the active tab stays');
});

test('apply bookmark: nests under Decltr, skips duplicates and non-web pages, undo cleans up', async () => {
  install();
  const plan = { actions: [{ type: 'bookmark', folder: 'Recipes', tabIds: [1, 2, 7] }] };
  const first = await applyPlan(plan, { windowId: 1 });
  assert.equal(first.stats.bookmarked, 2);
  const nodes = [...chrome.bookmarks.__nodes.values()];
  const folder = nodes.find((n) => n.title === 'Recipes');
  assert.equal(nodes.find((n) => n.id === folder.parentId).title, 'Decltr');
  assert.equal(nodes.find((n) => n.title === 'Decltr').parentId, '2', 'lives in Other bookmarks');

  const second = await applyPlan(plan, { windowId: 1 });
  assert.equal(second.stats.bookmarked, 0, 'already bookmarked');
  assert.equal(describeResult(second), 'Nothing needed to change.');
  await undoPlan(second.undo);
  assert.equal([...chrome.bookmarks.__nodes.values()].filter((n) => n.url).length, 2, 'undoing a no-op keeps earlier bookmarks');

  await undoPlan(first.undo);
  const left = [...chrome.bookmarks.__nodes.values()].filter((n) => n.title === 'Decltr' || n.title === 'Recipes' || n.url);
  assert.equal(left.length, 0);
});

test('combined plan: bookmark + close + group undoes cleanly in reverse order', async () => {
  install();
  const before = await signature();
  const res = await applyPlan(
    {
      actions: [
        { type: 'group', name: 'Dev', color: 'blue', tabIds: [1, 2] },
        { type: 'bookmark', folder: 'Later', tabIds: [3, 4] },
        { type: 'close', tabIds: [3, 4] },
        { type: 'move_to_new_window', tabIds: [5] },
      ],
    },
    { windowId: 1 },
  );
  assert.equal(describeResult(res), 'Grouped 2 tabs, moved 1 tab to a new window, bookmarked 2 tabs, closed 2 tabs.');
  await undoPlan(res.undo);
  assert.equal(await signature(), before);
  assert.equal([...chrome.bookmarks.__nodes.values()].filter((n) => n.url).length, 0);
});

test('one failing action does not stop the others', async () => {
  install();
  const realGroup = chrome.tabs.group;
  chrome.tabs.group = async () => {
    throw new Error('boom');
  };
  const res = await applyPlan(
    { actions: [{ type: 'group', name: 'X', color: 'red', tabIds: [1, 2] }, { type: 'close', tabIds: [3] }] },
    { windowId: 1 },
  );
  chrome.tabs.group = realGroup;
  assert.equal(res.stats.closed, 1);
  assert.equal(res.notes.length, 1);
});

test('snapshot excludes pinned tabs unless asked', async () => {
  install();
  assert.equal((await snapshot()).tabs.length, 6);
  const all = await snapshot({ includePinned: true });
  assert.equal(all.tabs.length, 7);
  assert.equal(all.pinnedCount, 1);
});

test('describeActions summarizes counts', () => {
  assert.equal(
    describeActions([
      { type: 'group', tabIds: [1, 2] },
      { type: 'group', tabIds: [3] },
      { type: 'close', tabIds: [4] },
    ]),
    'Group 3 tabs into 2 groups · Close 1 tab',
  );
});

// ---- ungroup and group management -------------------------------------------

function installGrouped() {
  return install({
    groups: [
      { id: 50, title: 'Dev', color: 'blue' },
      { id: 51, title: 'News', color: 'red' },
    ],
    tabs: SEED.map((t) => ({ ...t, groupId: t.id <= 2 ? 50 : t.id <= 4 ? 51 : -1 })),
  });
}
const groupTitles = () => chrome.__state.tabs.filter((t) => t.windowId === 1).map((t) => (t.groupId === -1 ? '-' : chrome.__state.groups.get(t.groupId).title));

test('ungroup all dissolves every group, keeps every tab, and undo rebuilds the groups', async () => {
  installGrouped();
  const before = await signature();
  const snap = await snapshot();
  const plan = planUngroupAll(snap.tabs);
  assert.deepEqual(plan.actions, [{ type: 'ungroup', tabIds: [1, 2, 3, 4] }]);

  const res = await applyPlan(plan, { windowId: 1 });
  assert.equal(res.stats.ungrouped, 4);
  assert.equal(describeResult(res), 'Ungrouped 4 tabs.');
  assert.equal(chrome.__state.groups.size, 0, 'empty groups disappear');
  assert.equal(chrome.__state.tabs.length, SEED.length, 'no tab was closed');

  await undoPlan(res.undo);
  assert.equal(await signature(), before, 'group names, colors and tab order are back');
});

test('ungrouping one group leaves the others and undo restores it', async () => {
  installGrouped();
  const before = await signature();
  const snap = await snapshot();
  const plan = planUngroupGroup(snap.tabs, 51, 'News');
  assert.deepEqual(plan.actions[0].tabIds, [3, 4]);

  const res = await applyPlan(plan, { windowId: 1 });
  assert.deepEqual(groupTitles().slice(0, 4), ['Dev', 'Dev', '-', '-']);
  await undoPlan(res.undo);
  assert.equal(await signature(), before);
});

test('ungrouping some tabs of a group keeps the group alive, and undo rejoins them', async () => {
  installGrouped();
  const before = await signature();
  const res = await applyPlan({ actions: [{ type: 'ungroup', tabIds: [2] }] }, { windowId: 1 });
  assert.equal(chrome.__state.groups.size, 2);
  assert.equal(chrome.__state.tabs.find((t) => t.id === 2).groupId, -1);
  await undoPlan(res.undo);
  assert.equal(await signature(), before);
});

test('ungroup skips tabs that are not in a group', async () => {
  installGrouped();
  const res = await applyPlan({ actions: [{ type: 'ungroup', tabIds: [1, 5, 999] }] }, { windowId: 1 });
  assert.equal(res.stats.ungrouped, 1);
  assert.equal(res.stats.skipped, 2);
});

test('regroup from scratch: ungroup everything then build new groups, undo returns to the original groups', async () => {
  installGrouped();
  const before = await signature();
  const res = await applyPlan(
    {
      actions: [
        { type: 'ungroup', tabIds: [1, 2, 3, 4] },
        { type: 'group', name: 'Work', color: 'green', tabIds: [1, 2, 3] },
        { type: 'group', name: 'Video', color: 'pink', tabIds: [4, 5] },
      ],
    },
    { windowId: 1 },
  );
  assert.deepEqual([...chrome.__state.groups.values()].map((g) => g.title).sort(), ['Video', 'Work']);
  assert.equal(describeResult(res), 'Ungrouped 4 tabs, grouped 5 tabs.');
  await undoPlan(res.undo);
  assert.equal(await signature(), before);
});

test('delete a group with its tabs, and undo brings the group and tabs back', async () => {
  installGrouped();
  const before = await signature();
  const snap = await snapshot();
  const plan = planCloseGroup(snap.tabs, 50, 'Dev');
  assert.deepEqual(plan.actions[0], { type: 'close', tabIds: [1, 2], reason: 'Part of the group \u201cDev\u201d' });

  const res = await applyPlan(plan, { windowId: 1 });
  assert.equal(res.stats.closed, 2);
  assert.equal(chrome.__state.groups.size, 1);
  await undoPlan(res.undo);
  assert.equal(await signature(), before, 'the Dev group is recreated with its title and color');
});

test('group planners say so when there is nothing to do', async () => {
  install();
  const snap = await snapshot();
  assert.equal(planUngroupAll(snap.tabs).actions.length, 0);
  assert.match(planUngroupAll(snap.tabs).message, /no tab groups/i);
  assert.equal(planCloseGroup(snap.tabs, 77, 'Gone').actions.length, 0);
});

test('the model sees unnamed groups, so their tabs are not mistaken for ungrouped ones', async () => {
  install({
    groups: [{ id: 60, title: '', color: 'red' }, { id: 61, title: 'Named', color: 'blue' }, { id: 62, title: '', color: 'pink' }],
    tabs: SEED.map((t) => ({ ...t, groupId: t.id === 1 ? 60 : t.id === 2 ? 61 : t.id === 3 ? 62 : -1 })),
  });
  const byId = new Map(toApiTabs(await snapshot()).map((t) => [t.id, t.group]));
  assert.equal(byId.get(1), 'Unnamed group 1');
  assert.equal(byId.get(2), 'Named');
  assert.equal(byId.get(3), 'Unnamed group 2', 'two unnamed groups stay distinguishable');
  assert.equal(byId.get(4), undefined, 'ungrouped tabs carry no group');
});

test('sanitizePlan only keeps ungroup for tabs that are really grouped', () => {
  const liveTabs = new Map([[1, { groupId: 50 }], [2, { groupId: -1 }], [3, { groupId: 51 }]]);
  const plan = sanitizePlan({ actions: [{ type: 'ungroup', tabIds: [1, 2, 3, 1] }, { type: 'ungroup', tabIds: [1] }] }, liveTabs);
  assert.deepEqual(plan.actions, [{ type: 'ungroup', tabIds: [1, 3] }], 'ungrouped tab 2 is dropped, tab 1 is not claimed twice');
  assert.equal(describeActions(plan.actions), 'Ungroup 2 tabs');
});

test('undo restores a collapsed group as collapsed after closing it, ungrouping it, or moving it', async () => {
  const seed = () => {
    install({
      groups: [{ id: 50, title: 'Dev', color: 'blue' }],
      tabs: SEED.map((t) => ({ ...t, groupId: t.id === 3 || t.id === 4 ? 50 : -1 })),
    });
    chrome.__state.groups.get(50).collapsed = true;
  };
  for (const action of [
    { type: 'close', tabIds: [3, 4] },
    { type: 'ungroup', tabIds: [3, 4] },
    { type: 'move_to_new_window', tabIds: [3, 4] },
  ]) {
    seed();
    const before = await signature();
    assert.match(before, /Dev\/blue\/collapsed/);
    const res = await applyPlan({ actions: [action] }, { windowId: 1 });
    await undoPlan(res.undo);
    assert.equal(await signature(), before, `${action.type}: group is back and still collapsed`);
  }
});

test('bookmarks made before the rename stay together: the old "Declt" folder is renamed, not abandoned', async () => {
  install();
  const other = (await chrome.bookmarks.getTree())[0].children.find((k) => k.folderType === 'other');
  const old = await chrome.bookmarks.create({ parentId: other.id, title: 'Declt' });
  const sub = await chrome.bookmarks.create({ parentId: old.id, title: 'Recipes' });
  await chrome.bookmarks.create({ parentId: sub.id, title: 'Earlier', url: 'https://earlier.example/' });

  const res = await applyPlan({ actions: [{ type: 'bookmark', folder: 'Recipes', tabIds: [1] }] }, { windowId: 1 });
  assert.equal(res.stats.bookmarked, 1);

  const folders = (await chrome.bookmarks.getChildren(other.id)).filter((n) => !n.url).map((n) => n.title);
  assert.deepEqual(folders, ['Decltr'], 'one folder, with the new name');
  const kept = await chrome.bookmarks.getChildren(sub.id);
  assert.deepEqual(kept.map((n) => n.title).sort(), ['Earlier', 'repo'], 'old and new bookmarks live in the same folder');

  // Undo must not delete a folder that existed before this action.
  await undoPlan(res.undo);
  assert.ok((await chrome.bookmarks.getChildren(other.id)).some((n) => n.title === 'Decltr'));
  assert.equal((await chrome.bookmarks.getChildren(sub.id)).length, 1, 'only the bookmark just added is removed');
});
