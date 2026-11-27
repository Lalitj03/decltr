// Installs the mock chrome API and a fake Decltr server before the panel loads.
import { createMockChrome } from './mock-chrome.js';
import { fingerprint, mergeSessions, sanitizeSession } from '../extension/lib/session-format.js';

const q = new URLSearchParams(location.search);
const mode = q.get('server') ?? 'ok';

const base = [
  { url: 'https://github.com/acme/web/pulls', title: 'Pull requests · acme/web', active: true },
  { url: 'https://github.com/acme/web/issues/42', title: 'Issue #42 · acme/web' },
  { url: 'https://github.com/acme/web/pulls', title: 'Pull requests · acme/web' },
  { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Array/map', title: 'Array.prototype.map() - JavaScript | MDN' },
  { url: 'https://www.seriouseats.com/garlic-pasta', title: 'Easy Garlic Pasta Recipe' },
  { url: 'https://www.kingarthurbaking.com/recipes/sourdough', title: 'Best Sourdough Bread | King Arthur Baking' },
  { url: 'https://www.google.com/travel/flights', title: 'Flights to Lisbon - Google Flights' },
  { url: 'https://www.booking.com/city/pt/lisbon.html', title: 'Hotels in Lisbon | Booking.com' },
  { url: 'https://www.youtube.com/watch?v=abc', title: 'lofi hip hop radio - beats to relax/study to', audible: true },
  { url: 'https://www.youtube.com/watch?v=xyz', title: 'How CSS container queries work' },
  { url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (12) - me@example.com', pinned: true },
  { url: 'https://chrome.google.com/webstore', title: 'Chrome Web Store' },
  { url: 'chrome://extensions/', title: 'Extensions' },
];
const extra = Array.from({ length: 24 }, (_, i) => ({ url: `https://news.example.com/story/${i}`, title: `Headline number ${i + 1}: something happened today` }));
// tabs=huge: a window like the one that failed, hundreds of tabs used at very different times (&n=650).
const DAY = 86_400_000;
const topicsHuge = [
  ['github.com/acme/web/pull/', 'Fix rendering bug · Pull Request #'], ['www.booking.com/hotel/pt/', 'Alfama hotel Lisbon | Booking.com '],
  ['www.seriouseats.com/', 'The Best Garlic Pasta Recipe '], ['arxiv.org/abs/2411.', 'Efficient attention for long context '],
  ['www.youtube.com/watch?v=', 'Live at Glastonbury (Full Set) '], ['www.irs.gov/forms-pubs/', 'About Form 1040 | IRS '],
  ['www.amazon.com/dp/B0', 'Laptop 14-inch, 32GB RAM '], ['kubernetes.io/docs/concepts/', 'Pods | Kubernetes '],
];
const huge = Array.from({ length: Number(q.get('n') ?? 650) }, (_, i) => {
  const [path, title] = topicsHuge[(i * 7 + Math.floor(i / 5)) % topicsHuge.length];
  const age = [0.2, 1, 3, 9, 16, 25, 40, 75, 120, 200][(i * 13) % 10] * DAY;
  return { url: `https://${path}${1000 + (i % 600)}`, title: `${title}${i % 600}`, lastAccessed: Date.now() - age - i * 1000 };
});
huge[0] = { ...huge[0], active: true, lastAccessed: Date.now() };
const lastUsed = (t, i) => ({ ...t, lastAccessed: Date.now() - [0, 2, 9, 20, 40, 100][i % 6] * DAY });
const tabs = q.get('tabs') === 'many' ? [...base, ...extra].map(lastUsed) : q.get('tabs') === 'huge' ? huge : base.map(lastUsed);

globalThis.chrome = createMockChrome({ tabs, loading: { commitMs: 30, titleMs: 60 } });
globalThis.__mock = globalThis.chrome;

// ai=ollama: Ollama on this computer is chosen and allowed, as after setting it up (used for the privacy
// screenshots). AI actions then go to a real Ollama at 127.0.0.1:11434, if one is running.
if (q.get('ai') === 'ollama') {
  globalThis.chrome.__state.storage.local['decltr.ai'] = { provider: 'ollama', ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' } };
  globalThis.chrome.permissions.__granted.add('http://127.0.0.1:11434/*');
}

const topics = [
  ['Dev', 'blue', /github|mozilla|mdn|stack/i],
  ['Recipes', 'orange', /recipe|pasta|bread|bak/i],
  ['Lisbon trip', 'green', /lisbon|flights|booking/i],
  ['Video', 'red', /youtube/i],
];

function fakePlan({ instruction, tabs }) {
  const wants = (re) => re.test(instruction);
  const actions = [];
  if (wants(/bookmark/i)) {
    const ids = tabs.filter((t) => /recipe|pasta|bread/i.test(`${t.title} ${t.url}`)).map((t) => t.id);
    actions.push({ type: 'bookmark', folder: 'Recipes', tabIds: ids });
    if (wants(/close/i)) actions.push({ type: 'close', tabIds: ids, reason: 'Saved to bookmarks first' });
  } else if (wants(/new window/i)) {
    actions.push({ type: 'move_to_new_window', tabIds: tabs.filter((t) => /youtube/i.test(t.url)).map((t) => t.id) });
  } else {
    for (const [name, color, re] of topics) {
      const ids = tabs.filter((t) => re.test(`${t.title} ${t.url}`)).map((t) => t.id);
      if (ids.length > 1) actions.push({ type: 'group', name, color, tabIds: ids });
    }
    if (wants(/close|tidy|clean/i)) actions.push({ type: 'close', tabIds: tabs.filter((t) => /chrome\.google\.com/.test(t.url)).map((t) => t.id), reason: 'Rarely needed page' });
  }
  if (wants(/^hello|weather/i)) return { summary: '', message: 'I can group, close, move or bookmark your tabs. What would you like to do?', actions: [] };
  return { summary: 'Here is how I would tidy this window.', message: '', actions };
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http://127.0.0.1:47821')) return realFetch(url, init);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  await new Promise((r) => setTimeout(r, 500));
  if (mode === 'offline') throw new TypeError('Failed to fetch');
  if (String(url).endsWith('/v1/health')) {
    return json(200, {
      ok: true, version: 'dev', features: ['plan', 'name', 'control', 'sessions'], managed: mode === 'managed', pid: 4242, model: 'mock', keyConfigured: mode !== 'nokey',
      sharing: { sessions: shared.sessions.size, browsers: shared.browsers.size, folder: '~/Library/Application Support/Decltr/shared' },
    });
  }
  if (String(url).endsWith('/v1/sessions/sync')) return json(200, fakeSync(JSON.parse(init.body)));
  if (mode === 'nokey') return json(503, { ok: false, error: { code: 'no_key', message: 'No key' } });
  if (mode === 'billing') return json(402, { ok: false, error: { code: 'billing', message: 'Your Gemini credits are used up. Add credits or billing for this Google Cloud project in AI Studio (aistudio.google.com), then try again.' } });
  await new Promise((r) => setTimeout(r, 900));
  return json(200, { ok: true, plan: fakePlan(JSON.parse(init.body)), model: 'mock' });
};

// A pretend shared store for the preview, with a "Microsoft Edge" that shares two sessions and keeps one live.
// Same rules as server/src/shared-store.js, without the files.
const EDGE = 'edge0000-0000-4000-8000-000000000000';
const shared = { rev: 0, sessions: new Map(), deleted: new Map(), browsers: new Map([[EDGE, { name: 'Microsoft Edge', lastSeen: Date.now() }]]), live: {} };
const edgeSession = (id, name, n, daysAgo) => ({
  id, name, nameSource: 'user', nameAt: Date.now() - daysAgo * 86400000, by: EDGE, createdAt: Date.now() - daysAgo * 86400000, updatedAt: Date.now() - daysAgo * 86400000,
  groups: [{ title: 'Reading', color: 'purple', collapsed: false }],
  tabs: Array.from({ length: n }, (_, i) => ({ url: `https://edge-${id.slice(0, 4)}.example/${i}`, title: `${name} page ${i + 1}`, favIcon: '', pinned: false, g: i < 3 ? 0 : -1 })),
});
for (const s of [edgeSession('edge1111-0000-4000-8000-000000000001', 'Q3 budget review', 18, 2), edgeSession('edge2222-0000-4000-8000-000000000002', 'Thesis research', 42, 5)]) {
  shared.sessions.set(s.id, { rev: ++shared.rev, session: s });
}
shared.live['edge2222-0000-4000-8000-000000000002'] = { browser: EDGE, since: Date.now() - 600000 };

function fakeSync(req) {
  if (q.get('sharing') === 'offline') throw new TypeError('Failed to fetch');
  const me = req.browser.id;
  if (req.leave) {
    shared.browsers.delete(me);
    return { ok: true, left: true };
  }
  shared.browsers.set(me, { name: req.browser.name, lastSeen: Date.now() });
  shared.browsers.get(EDGE).lastSeen = Date.now() - 40000;
  const results = [];
  for (const c of req.changes ?? []) {
    if (c.op === 'delete') {
      shared.sessions.delete(c.id);
      shared.deleted.set(c.id, { rev: ++shared.rev, by: me });
      results.push({ id: c.id, status: 'deleted', rev: shared.rev, by: me });
      continue;
    }
    const s = sanitizeSession(c.session);
    if (shared.deleted.has(s.id)) {
      results.push({ id: s.id, status: 'deleted', rev: shared.deleted.get(s.id).rev });
      continue;
    }
    const cur = shared.sessions.get(s.id)?.session;
    const merged = cur ? mergeSessions(cur, s) : { ...s, by: s.by ?? me };
    shared.sessions.set(s.id, { rev: ++shared.rev, session: merged });
    results.push(fingerprint(merged) === fingerprint(s) ? { id: s.id, status: 'saved', rev: shared.rev } : { id: s.id, status: 'merged', rev: shared.rev, session: merged });
  }
  for (const c of req.live?.claim ?? []) shared.live[c.id] = { browser: me, since: c.at };
  const changes = [];
  for (const [id, e] of shared.sessions) if (e.rev > (req.cursor ?? 0)) changes.push({ id, rev: e.rev, session: e.session });
  for (const [id, d] of shared.deleted) if (d.rev > (req.cursor ?? 0)) changes.push({ id, rev: d.rev, deleted: true, by: d.by });
  return {
    ok: true, epoch: 'preview', rev: shared.rev, cursor: shared.rev, more: false, results, changes, live: shared.live, count: shared.sessions.size,
    browsers: [...shared.browsers].map(([id, b]) => ({ id, name: b.name, lastSeen: b.lastSeen })),
  };
}
