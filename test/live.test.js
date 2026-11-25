import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import {
  applyAutoName, buildSession, deleteSession, LEGACY_KEY, loadSessions, renameSession, saveSession, SESSION_PREFIX, updateSessionContent,
} from '../extension/lib/sessions.js';
import { createTracker, getLinks, liveWindowFor, syncWindow } from '../extension/lib/tracker.js';
import { autoNameInBackground, clearSavedTabs, openTracked, removeSession, undoTrackedOpen } from '../extension/lib/session-ops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tracker;

function install(tabs = [{ id: 1, url: 'chrome://newtab/', title: 'New Tab', active: true }]) {
  globalThis.chrome = createMockChrome({ tabs });
  tracker = createTracker({ debounceMs: 5 });
  tracker.register();
}
/** Let events be delivered and debounce timers be set, then run the pending syncs. */
const settle = async () => {
  await sleep(25);
  await tracker.flush();
};

const mk = (urls, { groups = [], name = 'Work', nameSource } = {}) =>
  buildSession({
    name,
    nameSource,
    tabs: urls.map((u, i) => ({ id: i + 1, url: u.url ?? u, title: u.title ?? `Tab ${i + 1}`, pinned: Boolean(u.pinned), groupId: u.group ?? -1 })),
    groups: new Map(groups.map((g) => [g.id, g])),
  });
const stored = async (id) => (await loadSessions()).find((s) => s.id === id);
const urls = (session) => session.tabs.map((t) => t.url);

const THREE = () => mk(['https://a.example/', 'https://b.example/', 'https://c.example/'], { name: 'Research', nameSource: 'user' });

// ---- storage: migration, rename, auto-name --------------------------------------

test('sessions saved by the previous version are migrated to one entry per session', async () => {
  install();
  const old = mk(['https://a.example/'], { name: 'Old one' });
  await chrome.storage.local.set({ [LEGACY_KEY]: [old] });
  const list = await loadSessions();
  assert.deepEqual(list.map((s) => s.name), ['Old one']);
  assert.equal(list[0].nameSource, 'user', 'a legacy session counts as named by the user');
  const raw = await chrome.storage.local.get(null);
  assert.ok(!(LEGACY_KEY in raw), 'the legacy entry is removed');
  assert.ok(`${SESSION_PREFIX}${old.id}` in raw);
});

test('rename keeps everything else, rejects empty names, and survives a missing session', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const renamed = await renameSession(s.id, '  New   name  ');
  assert.equal(renamed.name, 'New name');
  assert.equal(renamed.nameSource, 'user');
  assert.deepEqual(urls(await stored(s.id)), urls(s));
  assert.equal(await renameSession(s.id, '   '), null);
  assert.equal((await stored(s.id)).name, 'New name');
  assert.equal(await renameSession('nope', 'x'), null);
});

test('an AI name applies only to a session that still has its default name', async () => {
  install();
  const fresh = mk(['https://a.example/'], { name: '' });
  assert.equal(fresh.nameSource, 'default');
  await saveSession(fresh);
  assert.equal(await applyAutoName(fresh.id, 'Lisbon Trip'), true);
  assert.deepEqual([(await stored(fresh.id)).name, (await stored(fresh.id)).nameSource], ['Lisbon Trip', 'ai']);

  const typed = mk(['https://a.example/'], { name: 'My name', nameSource: 'user' });
  await saveSession(typed);
  assert.equal(await applyAutoName(typed.id, 'AI name'), false, 'a name the user chose is never overwritten');
  assert.equal((await stored(typed.id)).name, 'My name');

  const raced = mk(['https://a.example/'], { name: '' });
  await saveSession(raced);
  await renameSession(raced.id, 'Typed while AI was thinking');
  assert.equal(await applyAutoName(raced.id, 'Late AI name'), false);
  assert.equal((await stored(raced.id)).name, 'Typed while AI was thinking');
  assert.equal(await applyAutoName('missing', 'x'), false);
});

test('background auto-naming: success, failure and user-named sessions', async () => {
  install();
  const s = mk(['https://a.example/', 'https://b.example/'], { name: '' });
  await saveSession(s);
  let sent;
  assert.equal(await autoNameInBackground(s, async (tabs) => ((sent = tabs), 'Study Notes')), true);
  assert.equal((await stored(s.id)).name, 'Study Notes');
  assert.equal(sent.length, 2, 'the session\'s own tabs are sent, not the live window');

  const failing = mk(['https://a.example/'], { name: '' });
  await saveSession(failing);
  assert.equal(await autoNameInBackground(failing, async () => { throw new Error('server offline'); }), false);
  assert.match((await stored(failing.id)).name, /^Session /, 'the default name stays when AI fails');

  const named = mk(['https://a.example/'], { name: 'Mine', nameSource: 'user' });
  let called = false;
  await autoNameInBackground(named, async () => ((called = true), 'x'));
  assert.equal(called, false, 'no request is made for a session the user already named');
});

// ---- live syncing ----------------------------------------------------------------

test('opening a session in a new window links it, and later changes are saved to it', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  assert.equal(info.tracking, true);
  assert.equal((await getLinks())[info.windowId], s.id);

  await chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' });
  await settle();
  assert.deepEqual(urls(await stored(s.id)), ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/']);

  const [first] = await chrome.tabs.query({ windowId: info.windowId });
  await chrome.tabs.remove(first.id);
  await settle();
  assert.deepEqual(urls(await stored(s.id)), ['https://b.example/', 'https://c.example/', 'https://d.example/']);
  assert.equal((await stored(s.id)).name, 'Research', 'the name is untouched by syncing');
});

test('navigation, pinning, grouping and collapsing are all kept', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  const [a, b, c] = await chrome.tabs.query({ windowId: info.windowId });

  chrome.__setTab(a.id, { url: 'https://a.example/moved', title: 'Moved' });
  await settle();
  assert.equal((await stored(s.id)).tabs[0].title, 'Moved');

  await chrome.tabs.update(c.id, { pinned: true });
  await settle();
  assert.equal((await stored(s.id)).tabs.find((t) => t.url === 'https://c.example/').pinned, true);

  const gid = await chrome.tabs.group({ tabIds: [a.id, b.id], createProperties: { windowId: info.windowId } });
  await chrome.tabGroups.update(gid, { title: 'Pair', color: 'pink' });
  await settle();
  let saved = await stored(s.id);
  assert.deepEqual(saved.groups, [{ title: 'Pair', color: 'pink', collapsed: false }]);

  await chrome.tabGroups.update(gid, { collapsed: true });
  await settle();
  saved = await stored(s.id);
  assert.equal(saved.groups[0].collapsed, true);
});

test('closing the window leaves the session exactly as last saved', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' });
  await settle();
  const before = await stored(s.id);
  assert.equal(before.tabs.length, 4);

  // A change is pending when the window closes. Nothing may be written from the half-closed window.
  await chrome.tabs.create({ windowId: info.windowId, url: 'https://e.example/' });
  await chrome.windows.remove(info.windowId);
  await settle();
  const after = await stored(s.id);
  assert.deepEqual(urls(after), urls(before), 'no partial save from a closing window');
  assert.deepEqual(await getLinks(), {}, 'the link is dropped once the window is gone');
});

test('tabs removed from a closing window are never written, even before the window is reported gone', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  const tabs = await chrome.tabs.query({ windowId: info.windowId });

  // Chrome has already removed two tabs of a window that is closing, and has not yet fired windows.onRemoved.
  const gone = tabs.slice(0, 2).map((t) => t.id);
  chrome.__state.tabs = chrome.__state.tabs.filter((t) => !gone.includes(t.id));
  for (const id of gone) chrome.__events.tabsRemoved.__emit(id, { windowId: info.windowId, isWindowClosing: true });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3, 'the half-closed window is not saved');

});

test('closing every real tab never empties the session', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await chrome.tabs.create({ windowId: info.windowId, url: 'chrome://newtab/' });
  const real = (await chrome.tabs.query({ windowId: info.windowId })).filter((t) => t.url.startsWith('https://'));
  await chrome.tabs.remove(real.map((t) => t.id));
  await settle();
  assert.equal(await syncWindow(info.windowId), 'skipped-empty');
  assert.equal((await stored(s.id)).tabs.length, 3);
});

test('opening a live session again switches to its window instead of making a copy', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const first = await openTracked(s, { target: 'new', windowId: 1 });
  const windowsBefore = (await chrome.windows.getAll()).length;
  const again = await openTracked(s, { target: 'new', windowId: 1 });
  assert.equal(again.switched, true);
  assert.equal(again.windowId, first.windowId);
  assert.equal((await chrome.windows.getAll()).length, windowsBefore, 'no extra window');
  assert.equal(chrome.__state.focusedWindow, first.windowId);
  assert.equal(await liveWindowFor(s.id), first.windowId);
});

test('a session follows one window: opening it into a blank window moves the link', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const first = await openTracked(s, { target: 'new', windowId: 1 });
  // Window 1 holds only a blank tab, so "this window" turns it into the session's window.
  const second = await openTracked(s, { target: 'here', windowId: 1 });
  assert.equal(second.tracking, true);
  assert.deepEqual(await getLinks(), { 1: s.id }, 'only the newest window is linked');

  await chrome.tabs.create({ windowId: first.windowId, url: 'https://old-window.example/' });
  await settle();
  assert.ok(!urls(await stored(s.id)).includes('https://old-window.example/'), 'the old window no longer writes to the session');
  await chrome.tabs.create({ windowId: 1, url: 'https://new-window.example/' });
  await settle();
  assert.ok(urls(await stored(s.id)).includes('https://new-window.example/'));
});

test('adding a session to a window that already has tabs does not make that window the session', async () => {
  install([{ id: 1, url: 'https://keep.example/', title: 'keep', active: true }]);
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'here', windowId: 1 });
  assert.equal(info.tracking, false);
  await chrome.tabs.create({ windowId: 1, url: 'https://unrelated.example/' });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3, 'unrelated tabs are not absorbed');
});

test('the setting turns live syncing off: nothing is linked and nothing is written', async () => {
  install();
  await chrome.storage.local.set({ liveSessions: false });
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  assert.equal(info.tracking, false);
  await chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3);

  // Turning it off while a window is already linked also stops writes.
  await chrome.storage.local.set({ liveSessions: true });
  const live = await openTracked(s, { target: 'new', windowId: 1 }).then((i) => (i.switched ? i : i));
  await chrome.storage.local.set({ liveSessions: false });
  await chrome.tabs.create({ windowId: live.windowId, url: 'https://e.example/' });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3);
});

test('deleting a live session does not bring it back', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await removeSession(s.id);
  await chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' });
  await settle();
  assert.deepEqual(await loadSessions(), []);
  assert.deepEqual(await getLinks(), {});

  // Even if a sync was already in flight when the delete happened.
  const t = THREE();
  await saveSession(t);
  const info2 = await openTracked(t, { target: 'new', windowId: 1 });
  await deleteSession(t.id); // link still present on purpose
  assert.equal(await syncWindow(info2.windowId), 'missing');
  assert.deepEqual(await loadSessions(), []);
});

test('renaming while live is not undone by the next sync, and the reverse', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await Promise.all([
    renameSession(s.id, 'Renamed'),
    chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' }).then(() => settle()),
  ]);
  await settle();
  const saved = await stored(s.id);
  assert.equal(saved.name, 'Renamed');
  assert.equal(saved.tabs.length, 4);

  // Simultaneous writers on the same session never lose each other's change.
  await Promise.all([
    renameSession(s.id, 'Again'),
    updateSessionContent(s.id, { tabs: saved.tabs.slice(0, 2), groups: [] }),
    applyAutoName(s.id, 'ignored'),
  ]);
  const final = await stored(s.id);
  assert.equal(final.name, 'Again');
  assert.equal(final.tabs.length, 2);
});

test('an unlinked window changes nothing and an unchanged window writes nothing', async () => {
  install([{ id: 1, url: 'https://x.example/', title: 'x', active: true }]);
  const s = THREE();
  await saveSession(s);
  await chrome.tabs.create({ windowId: 1, url: 'https://y.example/' });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3, 'a window that was never opened from the session is ignored');

  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await syncWindow(info.windowId); // opened tabs take their real titles once, so the first sync may write
  const stamp = (await stored(s.id)).updatedAt;
  assert.equal(await syncWindow(info.windowId), 'unchanged');
  await sleep(5);
  assert.equal((await stored(s.id)).updatedAt, stamp, 'no write when nothing changed');
});

// ---- the other features around it -------------------------------------------------

test('Save & clear on a live window cannot shrink the session that window was showing', async () => {
  install();
  const s = mk([{ url: 'https://pin.example/', pinned: true }, 'https://b.example/', 'https://c.example/'], { name: 'Live', nameSource: 'user' });
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  const tabs = await chrome.tabs.query({ windowId: info.windowId });
  const closable = tabs.filter((t) => !t.pinned).map((t) => t.id);

  await clearSavedTabs({ windowId: info.windowId, tabIds: closable });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 3, 'the pinned tab left behind is not written over the session');
  assert.deepEqual(await getLinks(), {}, 'the cleared window is no longer following the session');
});

test('undoing an open closes the window without touching the saved session', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  await chrome.tabs.create({ windowId: info.windowId, url: 'https://d.example/' });
  await settle();
  const before = await stored(s.id);

  await undoTrackedOpen(info);
  await settle();
  assert.ok(!chrome.__state.windows.has(info.windowId));
  assert.deepEqual(await stored(s.id), before);
  assert.deepEqual(await getLinks(), {});
});

test('undoing an open in a blank window restores the blank tab and stops syncing', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'here', windowId: 1 });
  assert.equal(info.tracking, true);
  await undoTrackedOpen(info);
  await settle();
  assert.deepEqual((await chrome.tabs.query({ windowId: 1 })).map((t) => t.url), ['chrome://newtab/']);
  assert.equal((await stored(s.id)).tabs.length, 3);
});

test('stale links are cleaned up: a window that no longer exists is not live', async () => {
  install();
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'new', windowId: 1 });
  chrome.__state.windows.delete(info.windowId);
  assert.equal(await liveWindowFor(s.id), null);
  assert.deepEqual(await getLinks(), {});
  const reopened = await openTracked(s, { target: 'new', windowId: 1 });
  assert.equal(reopened.switched, undefined, 'a fresh window is opened instead of switching to a dead one');
});

test('a window with no real tabs at all counts as blank, so a session opened there is followed', async () => {
  // Only the extension's own page is open: nothing real would be lost by turning the window into the session.
  install([{ id: 1, url: 'chrome-extension://testextensionid/sidepanel.html', title: 'Decltr', active: true }]);
  const s = THREE();
  await saveSession(s);
  const info = await openTracked(s, { target: 'here', windowId: 1 });
  assert.equal(info.wasBlank, true);
  assert.equal(info.removedBlank, 0);
  assert.equal(info.tracking, true);
  await chrome.tabs.create({ windowId: 1, url: 'https://d.example/' });
  await settle();
  assert.equal((await stored(s.id)).tabs.length, 4);
});

// ---- the product rename must not lose saved data --------------------------------------

test('sessions saved before the rename (declt.session.*) are moved to the new keys, with nothing lost', async () => {
  install();
  const a = mk(['https://a.example/', 'https://b.example/'], { name: 'Trip', nameSource: 'ai', groups: [{ id: 1, title: 'G', color: 'blue' }] });
  const b = mk(['https://c.example/'], { name: 'Notes', nameSource: 'user' });
  await chrome.storage.local.set({ [`declt.session.${a.id}`]: a, [`declt.session.${b.id}`]: b, includePinned: true });

  const list = await loadSessions();
  assert.deepEqual(list.map((s) => s.name).sort(), ['Notes', 'Trip']);
  assert.equal(list.find((s) => s.name === 'Trip').nameSource, 'ai', 'name provenance survives');
  assert.deepEqual(list.find((s) => s.name === 'Trip').tabs.map((t) => t.url), ['https://a.example/', 'https://b.example/']);

  const raw = await chrome.storage.local.get(null);
  assert.ok(!Object.keys(raw).some((k) => k.startsWith('declt.session.')), 'old keys are removed once copied');
  assert.ok(`${SESSION_PREFIX}${a.id}` in raw && `${SESSION_PREFIX}${b.id}` in raw);
  assert.equal(raw.includePinned, true, 'unrelated settings are untouched');
});

test('migration never overwrites a newer copy, and never deletes what it cannot read', async () => {
  install();
  const old = mk(['https://old.example/'], { name: 'Old name', nameSource: 'user' });
  const newer = { ...old, name: 'Renamed since', tabs: [...old.tabs, { url: 'https://added.example/', title: 'x', favIcon: '', pinned: false, g: -1 }] };
  await chrome.storage.local.set({
    [`declt.session.${old.id}`]: old,
    [`${SESSION_PREFIX}${old.id}`]: newer,
    'declt.session.broken': { id: 'broken', name: 'No tabs', tabs: 'garbage' },
  });
  const list = await loadSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Renamed since', 'the current copy wins');
  assert.equal(list[0].tabs.length, 2);
  const raw = await chrome.storage.local.get(null);
  assert.ok(!(`declt.session.${old.id}` in raw), 'the superseded old copy is dropped');
  assert.ok('declt.session.broken' in raw, 'an unreadable entry is left alone, not destroyed');
});

test('the v1 single-array format still migrates all the way to the current keys', async () => {
  install();
  const s = mk(['https://a.example/'], { name: 'Very old' });
  await chrome.storage.local.set({ [LEGACY_KEY]: [s] });
  assert.deepEqual((await loadSessions()).map((x) => x.name), ['Very old']);
  const raw = await chrome.storage.local.get(null);
  assert.ok(!(LEGACY_KEY in raw) && `${SESSION_PREFIX}${s.id}` in raw);
});

test('the panel notices old and new session keys when storage changes', async () => {
  const { isSessionKey } = await import('../extension/lib/sessions.js');
  assert.ok(isSessionKey('declt.session.abc') && isSessionKey('decltr.session.abc') && isSessionKey('declt.sessions'));
  assert.ok(!isSessionKey('includePinned') && !isSessionKey('decltr.links'));
});
