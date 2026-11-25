import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import { applyPlan, undoPlan } from '../extension/lib/actions.js';
import {
  buildSession, defaultSessionName, deleteSession, isBlankUrl, isRestorableUrl, loadSessions, openSession,
  sanitizeSessions, saveableTabs, saveSession, undoOpen, LEGACY_KEY, SESSION_PREFIX,
} from '../extension/lib/sessions.js';
import { snapshot } from '../extension/lib/tabs.js';

const WORK = [
  { id: 1, url: 'https://mail.example.com/', title: 'Mail', pinned: true },
  { id: 2, url: 'https://github.com/a/b', title: 'repo', groupId: 50, active: true },
  { id: 3, url: 'https://github.com/a/b/issues', title: 'issues', groupId: 50 },
  { id: 4, url: 'https://news.example.com/x', title: 'news', groupId: 51 },
  { id: 5, url: 'https://docs.example.com/', title: 'docs' },
  { id: 6, url: 'chrome://newtab/', title: 'New Tab' },
  { id: 7, url: 'javascript:alert(1)', title: 'bad' },
  { id: 8, url: 'chrome-extension://testextensionid/sidepanel.html', title: 'Decltr' },
];
const GROUPS = [
  { id: 50, title: 'Dev', color: 'blue' },
  { id: 51, title: 'News', color: 'red' },
];

function install(tabs = WORK, groups = GROUPS) {
  globalThis.chrome = createMockChrome({ tabs, groups });
  return globalThis.chrome;
}
const view = (windowId) =>
  chrome.__state.tabs
    .filter((t) => t.windowId === windowId)
    .sort((a, b) => a.index - b.index)
    .map((t) => {
      const g = t.groupId === -1 ? null : chrome.__state.groups.get(t.groupId);
      return `${t.url}${t.pinned ? ' [pinned]' : ''}${g ? ` {${g.title}/${g.color}${g.collapsed ? '/collapsed' : ''}}` : ''}`;
    });
const capture = async (name = 'Test', opts = {}) => {
  const snap = await snapshot({ includePinned: true, limit: Infinity, ...opts });
  return buildSession({ name, tabs: snap.tabs, groups: snap.groups });
};

test('url helpers', () => {
  assert.ok(isRestorableUrl('https://a.com/x?q=1#h') && isRestorableUrl('chrome://settings/') && isRestorableUrl('file:///tmp/a.html'));
  assert.ok(!isRestorableUrl('javascript:alert(1)') && !isRestorableUrl('data:text/html,hi') && !isRestorableUrl('chrome-extension://abc/x.html'));
  assert.ok(!isRestorableUrl('https://a.com/' + 'x'.repeat(9000)));
  assert.ok(isBlankUrl('chrome://newtab/') && isBlankUrl('chrome://new-tab-page/') && isBlankUrl('about:blank') && isBlankUrl(''));
  assert.ok(!isBlankUrl('https://a.com'));
});

test('buildSession keeps order, pinned state and groups, and skips what cannot be restored', async () => {
  install();
  const s = await capture('Research');
  assert.equal(s.name, 'Research');
  assert.deepEqual(s.tabs.map((t) => t.url), [
    'https://mail.example.com/', 'https://github.com/a/b', 'https://github.com/a/b/issues', 'https://news.example.com/x', 'https://docs.example.com/',
  ], 'new tab, javascript: and Decltr itself are left out');
  assert.deepEqual(s.groups, [{ title: 'Dev', color: 'blue', collapsed: false }, { title: 'News', color: 'red', collapsed: false }]);
  assert.deepEqual(s.tabs.map((t) => t.g), [-1, 0, 0, 1, -1]);
  assert.equal(s.tabs[0].pinned, true);
});

test('pinned tabs are only saved when included, matching the rest of the app', async () => {
  install();
  const snap = await snapshot({ includePinned: false, limit: Infinity });
  const s = buildSession({ name: 'x', tabs: snap.tabs, groups: snap.groups });
  assert.ok(!s.tabs.some((t) => t.pinned));
});

test('long names are trimmed, favicons must be small http(s) urls, empty names get a default', () => {
  const tabs = [
    { id: 1, url: 'https://a.com', title: 'A', groupId: -1, favIconUrl: 'data:image/png;base64,AAAA' },
    { id: 2, url: 'https://b.com', title: 'B', groupId: -1, favIconUrl: 'https://b.com/favicon.ico' },
  ];
  const s = buildSession({ name: '  ' + 'n'.repeat(200), tabs, groups: new Map() });
  assert.equal(s.name.length, 60);
  assert.equal(s.tabs[0].favIcon, '');
  assert.equal(s.tabs[1].favIcon, 'https://b.com/favicon.ico');
  assert.match(buildSession({ name: '', tabs, groups: new Map() }).name, /^Session /);
  assert.match(defaultSessionName(new Date(2026, 0, 5, 9, 7)), /^Session /);
});

test('storage roundtrip: newest first, replace by id, delete', async () => {
  install();
  const a = buildSession({ name: 'A', tabs: [{ id: 1, url: 'https://a.com', title: 'a', groupId: -1 }], groups: new Map(), now: 1000, id: 'a' });
  const b = buildSession({ name: 'B', tabs: [{ id: 1, url: 'https://b.com', title: 'b', groupId: -1 }], groups: new Map(), now: 2000, id: 'b' });
  await saveSession(a);
  await saveSession(b);
  assert.deepEqual((await loadSessions()).map((s) => s.name), ['B', 'A']);
  await saveSession({ ...a, name: 'A2' });
  assert.deepEqual((await loadSessions()).map((s) => s.name), ['B', 'A2']);
  await deleteSession('b');
  assert.deepEqual((await loadSessions()).map((s) => s.id), ['a']);
});

test('saving reports a clear error when storage is full', async () => {
  install();
  chrome.storage.local.set = async () => {
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  const s = buildSession({ name: 'A', tabs: [{ id: 1, url: 'https://a.com', title: 'a', groupId: -1 }], groups: new Map() });
  await assert.rejects(saveSession(s), /Not enough browser storage/);
});

test('corrupt or hostile stored data is dropped, not trusted', async () => {
  const clean = sanitizeSessions([
    null,
    'x',
    { id: 'ok', name: 'Fine', createdAt: 5, tabs: [{ url: 'https://a.com', title: 't', g: 0 }, { url: 'javascript:alert(1)', title: 'evil' }], groups: [{ title: 'G', color: 'neon' }] },
    { id: 'empty', name: 'No tabs', tabs: [] },
    { name: 'no id', tabs: [{ url: 'https://a.com' }] },
    { id: 'badg', name: 'Bad group index', tabs: [{ url: 'https://a.com', g: 9 }], groups: [] },
  ]);
  assert.deepEqual(clean.map((s) => s.id), ['ok', 'badg']);
  assert.equal(clean[0].tabs.length, 1, 'javascript: url removed');
  assert.equal(clean[0].groups[0].color, 'grey', 'unknown color falls back');
  assert.equal(clean[1].tabs[0].g, -1, 'dangling group index falls back');
  assert.deepEqual(sanitizeSessions('garbage'), []);
  assert.equal(LEGACY_KEY, 'declt.sessions', 'the pre-rename key is kept only so old data can be migrated');
  assert.equal(SESSION_PREFIX, 'decltr.session.');
});

test('open in a new window recreates tabs in order with pinned state and groups; the original window is untouched', async () => {
  install();
  const session = await capture('Research');
  session.groups[1].collapsed = true;
  const before = view(1);

  const info = await openSession(session, { target: 'new', windowId: 1 });
  assert.equal(info.newWindow, true);
  assert.equal(info.failed.length, 0);
  assert.deepEqual(view(1), before, 'window 1 is unchanged');
  assert.deepEqual(view(info.windowId), [
    'https://mail.example.com/ [pinned]',
    'https://github.com/a/b {Dev/blue}',
    'https://github.com/a/b/issues {Dev/blue}',
    'https://news.example.com/x {News/red/collapsed}',
    'https://docs.example.com/',
  ], 'no stray blank tab is left in the new window');
  assert.equal(chrome.__state.tabs.filter((t) => t.windowId === info.windowId && t.active).length, 1);

  await undoOpen(info);
  assert.ok(!chrome.__state.windows.has(info.windowId), 'undo closes the window it opened');
  assert.deepEqual(view(1), before);
});

test('a collapsed group is restored collapsed, except the one holding the tab that becomes active', async () => {
  install([], []);
  const session = buildSession({
    name: 'S',
    tabs: [
      { id: 1, url: 'https://first.example.com/', title: 'first', groupId: 1 },
      { id: 2, url: 'https://second.example.com/', title: 'second', groupId: 2 },
    ],
    groups: new Map([[1, { title: 'Holds active', color: 'blue', collapsed: true }], [2, { title: 'Other', color: 'red', collapsed: true }]]),
  });
  assert.equal(session.groups[0].collapsed, true, 'collapsed state is saved');
  const info = await openSession(session, { target: 'new', windowId: 1 });
  const byTitle = Object.fromEntries([...chrome.__state.groups.values()].map((g) => [g.title, g.collapsed]));
  assert.deepEqual(byTitle, { 'Holds active': false, Other: true });
  assert.equal(info.failed.length, 0);
});

test('open here appends to a window that has other tabs, and undo removes only what was opened', async () => {
  install([{ id: 1, url: 'https://keep.example.com/', title: 'keep', active: true }]);
  const session = buildSession({
    name: 'S',
    tabs: [{ id: 9, url: 'https://x.example.com/', title: 'x', groupId: 7 }, { id: 10, url: 'https://y.example.com/', title: 'y', groupId: 7 }],
    groups: new Map([[7, { title: 'Pair', color: 'pink', collapsed: false }]]),
  });
  const info = await openSession(session, { target: 'here', windowId: 1 });
  assert.deepEqual(view(1), ['https://keep.example.com/', 'https://x.example.com/ {Pair/pink}', 'https://y.example.com/ {Pair/pink}']);
  assert.equal(info.removedBlank, 0);

  await undoOpen(info);
  assert.deepEqual(view(1), ['https://keep.example.com/']);
  assert.equal(chrome.__state.groups.size, 0);
});

test('open here replaces the blank tab left by Save & clear, and undo puts a blank tab back', async () => {
  install([{ id: 1, url: 'chrome://newtab/', title: 'New Tab', active: true }], []);
  const session = buildSession({ name: 'S', tabs: [{ id: 9, url: 'https://x.example.com/', title: 'x', groupId: -1 }], groups: new Map() });
  const info = await openSession(session, { target: 'here', windowId: 1 });
  assert.equal(info.removedBlank, 1);
  assert.deepEqual(view(1), ['https://x.example.com/']);

  await undoOpen(info);
  assert.deepEqual(view(1), ['chrome://newtab/'], 'the window never ends up empty');
});

test('tabs that fail to open are reported and the rest still open', async () => {
  install([{ id: 1, url: 'chrome://newtab/', title: 'New Tab' }], []);
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = async (props) => {
    if (props.url.includes('broken')) throw new Error('Cannot open');
    return realCreate(props);
  };
  const session = buildSession({
    name: 'S',
    tabs: [{ id: 1, url: 'https://ok.example.com/', title: 'ok', groupId: -1 }, { id: 2, url: 'https://broken.example.com/', title: 'b', groupId: -1 }],
    groups: new Map(),
  });
  const info = await openSession(session, { target: 'here', windowId: 1 });
  assert.deepEqual(info.failed, ['https://broken.example.com/']);
  assert.deepEqual(view(1), ['https://ok.example.com/']);
});

test('if nothing can be opened, a freshly created window is closed again', async () => {
  install();
  chrome.tabs.create = async () => {
    throw new Error('nope');
  };
  const session = buildSession({ name: 'S', tabs: [{ id: 1, url: 'https://a.com', title: 'a', groupId: -1 }], groups: new Map() });
  const info = await openSession(session, { target: 'new', windowId: 1 });
  assert.equal(info.createdIds.length, 0);
  assert.equal(chrome.__state.windows.size, 1, 'no empty window is left behind');
});

test('save & clear closes exactly the saved tabs, keeps the window alive, and can be undone', async () => {
  install();
  const snap = await snapshot({ includePinned: false, limit: Infinity });
  const session = buildSession({ name: 'Wrap up', tabs: snap.tabs, groups: snap.groups });
  const saved = saveableTabs(snap.tabs).map((t) => t.id);
  assert.deepEqual(saved, [2, 3, 4, 5], 'pinned tab, new tab, javascript: and Decltr itself are not part of it');

  await saveSession(session);
  const res = await applyPlan({ actions: [{ type: 'close', tabIds: saved }] }, { windowId: 1 });
  assert.equal(res.stats.closed, 4);
  assert.deepEqual(view(1).sort(), ['chrome-extension://testextensionid/sidepanel.html', 'chrome://newtab/', 'https://mail.example.com/ [pinned]', 'javascript:alert(1)'].sort());
  assert.equal((await loadSessions()).length, 1, 'the session is still stored');

  // Reopen it somewhere else, then undo the clear: both coexist.
  const opened = await openSession((await loadSessions())[0], { target: 'new', windowId: 1 });
  assert.equal(opened.createdIds.length, 4);
  await undoPlan(res.undo);
  assert.ok(view(1).includes('https://github.com/a/b {Dev/blue}'));
});
