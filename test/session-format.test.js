// The session format: checking, comparing, merging, export files and reading import files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockChrome } from '../dev/mock-chrome.js';
import {
  contentKey, exportFile, exportFileName, fingerprint, FILE_FORMAT, matchesQuery, mergeSessions, parseImport, sanitizeSession,
  sessionsToMarkdown, SESSION_LIMITS,
} from '../extension/lib/session-format.js';
import {
  addSessions, buildSession, DELETED_KEY, deleteSession, loadSessions, MAX_SESSIONS, removeSessions, saveSession,
} from '../extension/lib/sessions.js';

const NOW = Date.UTC(2026, 10, 27, 9, 30);
const session = (over = {}) => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 'Lisbon trip',
  nameSource: 'user',
  nameAt: NOW - 5000,
  createdAt: NOW - 10_000,
  updatedAt: NOW - 3000,
  groups: [{ title: 'Flights', color: 'green', collapsed: false }],
  tabs: [
    { url: 'https://flights.example/lis', title: 'Flights to Lisbon', favIcon: 'https://flights.example/i.png', pinned: false, g: 0, used: NOW - 9000 },
    { url: 'https://hotels.example/lis', title: 'Hotels', favIcon: '', pinned: false, g: -1 },
  ],
  ...over,
});

// ---- checking ------------------------------------------------------------------------

test('sanitizing: storage keeps browser pages and icons, files keep only web pages and local files, without icons', () => {
  const raw = session({
    tabs: [
      { url: 'https://a.example/', title: 'A\u0000\u202eevil', favIcon: 'https://a.example/i.png', g: 0 },
      { url: 'chrome://settings/', title: 'Settings' },
      { url: 'javascript:alert(1)', title: 'x' },
      { url: 'data:text/html,hi', title: 'x' },
      { url: 'file:///Users/me/notes.pdf', title: 'Notes' },
      { url: 'chrome-extension://abc/page.html', title: 'x' },
    ],
  });
  const stored = sanitizeSession(raw);
  assert.deepEqual(stored.tabs.map((t) => t.url), ['https://a.example/', 'chrome://settings/', 'file:///Users/me/notes.pdf']);
  assert.equal(stored.tabs[0].title, 'A evil', 'control and direction characters are removed');
  assert.equal(stored.tabs[0].favIcon, 'https://a.example/i.png');

  const counts = { skipped: 0 };
  const fromFile = sanitizeSession(raw, { fromFile: true, counts });
  assert.deepEqual(fromFile.tabs.map((t) => t.url), ['https://a.example/', 'file:///Users/me/notes.pdf']);
  assert.ok(fromFile.tabs.every((t) => t.favIcon === ''), 'no icon addresses from files');
  assert.equal(fromFile.id, undefined, 'files never decide IDs');
  assert.equal(counts.skipped, 4);
});

test('sanitizing: limits, bad fields and the creating browser', () => {
  const many = session({ tabs: Array.from({ length: SESSION_LIMITS.tabs + 10 }, (_, i) => ({ url: `https://x.example/${i}` })) });
  assert.equal(sanitizeSession(many).tabs.length, SESSION_LIMITS.tabs);
  const odd = sanitizeSession(session({ name: 'n'.repeat(500), nameSource: 'robot', kind: 'evil', by: '../../etc', createdAt: -5, updatedAt: 'soon' }));
  assert.equal(odd.name.length, SESSION_LIMITS.name);
  assert.equal(odd.nameSource, 'user');
  assert.equal(odd.kind, undefined);
  assert.equal(odd.by, undefined, 'a browser ID must be safe to use as a file name');
  assert.equal(odd.createdAt, 0);
  assert.equal(odd.updatedAt, 0);
  assert.equal(sanitizeSession(session({ by: 'bbbbbbbb-1111-2222-3333-444444444444' })).by, 'bbbbbbbb-1111-2222-3333-444444444444');
  assert.equal(sanitizeSession(session({ tabs: [{ url: 'javascript:x' }] })), null, 'nothing usable left');
  assert.equal(sanitizeSession({ id: 5, tabs: [] }), null);
  assert.equal(sanitizeSession(session({ nameAt: undefined })).nameAt, NOW - 10_000, 'older sessions count their name from when they were made');
});

// ---- comparing -----------------------------------------------------------------------

test('fingerprint: same session in any key order, different when anything shared changes', () => {
  const a = session();
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  reordered.tabs = a.tabs.map((t) => Object.fromEntries(Object.entries(t).reverse()));
  assert.equal(fingerprint(reordered), fingerprint(a));
  assert.equal(fingerprint({ ...a, id: 'other-id-1234' }), fingerprint(a), 'the ID is not part of it');
  assert.equal(fingerprint({ ...a, by: 'cccccccc-1111' }), fingerprint(a), 'nor the browser that made it');
  for (const change of [{ name: 'Porto' }, { nameSource: 'ai' }, { updatedAt: NOW }, { groups: [{ title: 'Trains', color: 'green', collapsed: false }] }, { tabs: a.tabs.slice(0, 1) }]) {
    assert.notEqual(fingerprint({ ...a, ...change }), fingerprint(a), JSON.stringify(change));
  }
});

test('content key: same pages in the same groups match, whatever the name and titles', () => {
  const a = session();
  assert.equal(contentKey({ ...a, name: 'Other', tabs: a.tabs.map((t) => ({ ...t, title: 'changed', used: 1 })) }), contentKey(a));
  assert.notEqual(contentKey({ ...a, tabs: [...a.tabs].reverse() }), contentKey(a));
  assert.notEqual(contentKey({ ...a, groups: [{ title: 'Trains', color: 'green' }] }), contentKey(a));
});

test('merging: a typed name beats an AI name beats the date; otherwise the later change wins, name and tabs separately', () => {
  const base = session({ nameSource: 'default', name: 'Session 27 Nov', nameAt: NOW - 10_000 });
  const typed = { ...base, name: 'Lisbon', nameSource: 'user', nameAt: NOW - 8000 };
  const ai = { ...base, name: 'Lisbon Trip Planning', nameSource: 'ai', nameAt: NOW - 1000 };
  assert.equal(mergeSessions(typed, ai).name, 'Lisbon', 'typed wins although the AI name is later');
  assert.equal(mergeSessions(ai, typed).name, 'Lisbon');
  assert.equal(mergeSessions(base, ai).name, 'Lisbon Trip Planning');
  const later = { ...typed, name: 'Lisbon 2027', nameAt: NOW };
  assert.equal(mergeSessions(typed, later).name, 'Lisbon 2027');

  // Renamed in one browser, tabs changed in the other: both are kept.
  const renamed = { ...base, name: 'Lisbon', nameSource: 'user', nameAt: NOW };
  const moreTabs = { ...base, updatedAt: NOW, tabs: [...base.tabs, { url: 'https://trains.example/', title: 'Trains', favIcon: '', pinned: false, g: -1 }] };
  const merged = mergeSessions(renamed, moreTabs);
  assert.equal(merged.name, 'Lisbon');
  assert.equal(merged.tabs.length, 3);
  assert.equal(merged.updatedAt, NOW);
  assert.equal(mergeSessions({ ...base, kind: 'archive' }, base).kind, 'archive');
  assert.equal(mergeSessions({ ...base, createdAt: 5 }, base).createdAt, 5);
});

test('merging gives the same result in any order, and merging again changes nothing', () => {
  const variants = [];
  const sources = ['default', 'ai', 'user'];
  for (let i = 0; i < 12; i++) {
    variants.push(session({
      name: `Name ${i % 4}`, nameSource: sources[i % 3], nameAt: NOW - (i % 5) * 100,
      updatedAt: NOW - (i % 4) * 100, tabs: [{ url: `https://site${i % 3}.example/`, title: `T${i}`, favIcon: '', pinned: false, g: -1 }], groups: [],
    }));
  }
  const fp = (s) => fingerprint(s);
  for (const a of variants) {
    assert.equal(fp(mergeSessions(a, a)), fp(a), 'idempotent');
    for (const b of variants) {
      assert.equal(fp(mergeSessions(a, b)), fp(mergeSessions(b, a)), 'commutative');
      for (const c of variants.slice(0, 6)) {
        assert.equal(fp(mergeSessions(mergeSessions(a, b), c)), fp(mergeSessions(a, mergeSessions(b, c))), 'associative');
      }
    }
  }
});

test('finding: every word must appear in the name, a group, a title or an address', () => {
  const a = session();
  const cache = new Map();
  assert.ok(matchesQuery(a, 'lisbon hotels', cache));
  assert.ok(matchesQuery(a, 'FLIGHTS.example', cache));
  assert.ok(matchesQuery(a, '', cache));
  assert.ok(!matchesQuery(a, 'lisbon porto', cache));
});

// ---- files -----------------------------------------------------------------------------

test('export file: versioned, no IDs or icon addresses, and it reads back the same', () => {
  const sessions = [session(), session({ id: 'bbbbbbbb-1111-2222-3333-444444444444', name: 'Archive', kind: 'archive', groups: [] , tabs: [{ url: 'https://old.example/', title: 'Old', favIcon: 'https://old.example/i.png', pinned: true, g: -1, used: NOW - 1e9 }] })];
  const file = exportFile(sessions, { app: 'Decltr 0.7.0', browser: 'Google Chrome', now: NOW });
  assert.equal(file.format, FILE_FORMAT);
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, new Date(NOW).toISOString());
  const text = JSON.stringify(file);
  assert.ok(!text.includes('aaaaaaaa') && !text.includes('favIcon') && !text.includes('i.png'));

  const back = parseImport(text, { now: NOW });
  assert.equal(back.ok, true);
  assert.equal(back.kind, 'decltr');
  assert.deepEqual(back.from, { app: 'Decltr 0.7.0', browser: 'Google Chrome' });
  assert.equal(back.exportedAt, NOW);
  const strip = (s) => ({ ...s, tabs: s.tabs.map(({ favIcon, ...t }) => t) });
  assert.deepEqual(back.sessions.map(strip), sessions.map(({ id, ...s }) => strip(s)));
  assert.equal(exportFileName(sessions, NOW), 'Decltr sessions 2026-11-27.json');
  assert.equal(exportFileName([{ name: 'Q3: budget / review?' }], NOW), 'Decltr Q3 budget review 2026-11-27.json');
});

test('copy as links: Markdown that reads back into the same sessions and groups', () => {
  const s = session({ tabs: [
    { url: 'https://hotels.example/lis', title: 'Hotels [best]', favIcon: '', pinned: false, g: -1 },
    { url: 'https://flights.example/a(b)', title: 'Flights', favIcon: '', pinned: false, g: 0 },
  ] });
  const md = sessionsToMarkdown([s, { ...s, name: 'Second', groups: [], tabs: [{ url: 'https://x.example/', title: '', favIcon: '', pinned: false, g: -1 }] }]);
  assert.match(md, /^## Lisbon trip\n\n- \[Hotels best\]\(https:\/\/hotels.example\/lis\)\n\n### Flights\n\n- \[Flights\]\(https:\/\/flights.example\/a\(b%29\)/);
  const back = parseImport(md, { fileName: 'notes.md', now: NOW });
  assert.equal(back.ok, true);
  assert.deepEqual(back.sessions.map((x) => x.name), ['Lisbon trip', 'Second']);
  assert.deepEqual(back.sessions[0].groups.map((g) => g.title), ['Flights']);
  assert.deepEqual(back.sessions[0].tabs.map((t) => [t.url, t.title, t.g]), [['https://hotels.example/lis', 'Hotels best', -1], ['https://flights.example/a(b)', 'Flights', 0]]);
});

test('lists of links: OneTab blocks, plain text, a bookmarks file', () => {
  const oneTab = 'https://a.example/1 | First page\nhttps://a.example/2 | Second\n\nhttps://b.example/ | Another block\n';
  const r1 = parseImport(oneTab, { fileName: 'onetab export.txt', now: NOW });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.sessions.map((s) => [s.name, s.tabs.length]), [['onetab export 1', 2], ['onetab export 2', 1]]);
  assert.equal(r1.sessions[0].tabs[0].title, 'First page');

  const notes = 'Reading list:\n- Lisbon hotels - https://hotels.example/lis.\n- see https://a.example/x and https://b.example/y\n\nmore https://c.example/z';
  const r2 = parseImport(notes, { fileName: 'notes.txt', now: NOW });
  assert.equal(r2.sessions.length, 1, 'blank lines only split OneTab files');
  assert.deepEqual(r2.sessions[0].tabs.map((t) => [t.url, t.title]), [
    ['https://hotels.example/lis', 'Lisbon hotels'], ['https://a.example/x', 'https://a.example/x'], ['https://b.example/y', 'https://b.example/y'], ['https://c.example/z', 'more'],
  ]);
  assert.equal(r2.sessions[0].name, 'notes');

  const bookmarks = '<DT><A HREF="https://a.example/" ADD_DATE="1700000000" ICON="data:image/png;base64,AAAA">Example A</A>\n<DT><A HREF="https://b.example/">B</A>';
  const r3 = parseImport(bookmarks, { fileName: 'bookmarks.html', now: NOW });
  assert.deepEqual(r3.sessions[0].tabs.map((t) => [t.url, t.title]), [['https://a.example/', 'Example A'], ['https://b.example/', 'B']]);
});

test('import files from someone else cannot smuggle anything in', () => {
  const hostile = JSON.stringify({
    format: FILE_FORMAT, version: 1, exportedAt: 'never',
    from: { app: '<img src=x onerror=alert(1)>', browser: 'B'.repeat(500) },
    sessions: [
      { name: '__proto__', createdAt: NOW + 9e12, updatedAt: -1, nameAt: NOW + 9e12, tabs: [
        { url: 'javascript:alert(document.cookie)', title: 'x' }, { url: 'chrome://quit/', title: 'x' }, { url: 'https://ok.example/', title: '<b>hi</b>', favIcon: 'https://tracker.example/pixel.png', used: 'x' },
      ] },
      { constructor: 'x', tabs: 'not a list' },
      null,
      { name: 'Dupe', tabs: [{ url: 'https://ok.example/' }] },
    ],
  });
  const r = parseImport(hostile, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.sessions.length, 1, 'the second copy of the same pages is a duplicate');
  assert.equal(r.duplicates, 1);
  const [s] = r.sessions;
  assert.deepEqual(s.tabs.map((t) => t.url), ['https://ok.example/']);
  assert.equal(s.tabs[0].favIcon, '');
  assert.equal(s.tabs[0].title, '<b>hi</b>', 'titles stay text; the panel only ever shows them as text');
  assert.equal(s.createdAt, NOW, 'a date far in the future is not trusted');
  assert.ok(s.nameAt <= NOW && s.updatedAt >= s.createdAt);
  assert.equal(r.skipped, 2);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(r.from.browser.length, 40);
  assert.equal(r.exportedAt, undefined);

  assert.equal(parseImport('', {}).code, 'empty');
  assert.equal(parseImport('just some words, no links', {}).code, 'not_sessions');
  assert.equal(parseImport('{"format":"other"}', {}).code, 'not_sessions');
  assert.equal(parseImport(JSON.stringify({ format: FILE_FORMAT, version: 2, sessions: [] }), {}).code, 'newer');
  assert.equal(parseImport(JSON.stringify({ format: FILE_FORMAT, version: 1, sessions: [{ tabs: [{ url: 'chrome://settings/' }] }] }), {}).code, 'nothing_usable');
  assert.equal(parseImport('['.repeat(100_000), {}).code, 'not_sessions', 'deeply nested junk is refused, not a crash');
  const many = { format: FILE_FORMAT, version: 1, sessions: Array.from({ length: 1003 }, (_, i) => ({ name: `S${i}`, tabs: [{ url: `https://x.example/${i}` }] })) };
  const big = parseImport(JSON.stringify(many), { now: NOW });
  assert.equal(big.sessions.length, 1000);
  assert.match(big.notes[0], /first 1000 of 1003/);
});

// ---- storage: limits, bulk add, deletions --------------------------------------------------

test('storage: the newest 1000 sessions are listed, and a 1001st is refused with a clear message', async () => {
  globalThis.chrome = createMockChrome();
  const make = (i) => ({ ...buildSession({ name: `S${i}`, tabs: [{ id: 1, url: `https://x.example/${i}`, title: 'x', groupId: -1 }], groups: new Map(), now: NOW - (2000 - i) * 1000 }) });
  // 1005 stored (an older version allowed it), oldest first in storage: the 5 oldest are the ones left out.
  const all = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => make(i));
  await chrome.storage.local.set(Object.fromEntries(all.map((x) => [`decltr.session.${x.id}`, x])));
  const listed = await loadSessions();
  assert.equal(listed.length, MAX_SESSIONS);
  assert.equal(listed[0].name, `S${MAX_SESSIONS + 4}`, 'newest first');
  assert.equal(listed.at(-1).name, 'S5', 'the oldest are left out, not whichever came last in storage');
  await chrome.storage.local.remove(all.slice(0, 5).map((x) => `decltr.session.${x.id}`));
  await assert.rejects(saveSession(make(5000)), /up to 1000 sessions/);
  await assert.rejects(addSessions([make(5001)]), (e) => e.code === 'too_many');
  await saveSession({ ...listed[3], name: 'Renamed' }); // replacing one is fine
});

test('storage: adding many at once, and deleting records which sessions were deleted on purpose', async () => {
  globalThis.chrome = createMockChrome();
  const a = buildSession({ name: 'A', tabs: [{ id: 1, url: 'https://a.example/', groupId: -1 }], groups: new Map() });
  const b = buildSession({ name: 'B', tabs: [{ id: 1, url: 'https://b.example/', groupId: -1 }], groups: new Map() });
  const c = buildSession({ name: 'C', tabs: [{ id: 1, url: 'https://c.example/', groupId: -1 }], groups: new Map() });
  assert.deepEqual(await addSessions([a, b, c]), [a.id, b.id, c.id]);
  assert.equal((await loadSessions()).length, 3);
  await removeSessions([a.id, b.id]);
  await deleteSession(c.id);
  assert.equal((await loadSessions()).length, 0);
  const deleted = (await chrome.storage.local.get(DELETED_KEY))[DELETED_KEY];
  assert.deepEqual(deleted.map((d) => d.id), [a.id, b.id, c.id]);
  assert.ok(a.nameAt > 0, 'new sessions know when they were named');
});
