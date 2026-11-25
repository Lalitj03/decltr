// Installs the mock chrome API and a fake Decltr server before the panel loads.
import { createMockChrome } from './mock-chrome.js';

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
const tabs = q.get('tabs') === 'many' ? [...base, ...extra] : base;

globalThis.chrome = createMockChrome({ tabs });
globalThis.__mock = globalThis.chrome;

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
  if (String(url).endsWith('/v1/health')) return json(200, { ok: true, version: 'dev', features: ['plan', 'name', 'control'], managed: mode === 'managed', pid: 4242, model: 'mock', keyConfigured: mode !== 'nokey' });
  if (mode === 'nokey') return json(503, { ok: false, error: { code: 'no_key', message: 'No key' } });
  if (mode === 'billing') return json(402, { ok: false, error: { code: 'billing', message: 'Your Gemini credits are used up. Add credits or billing for this Google Cloud project in AI Studio (aistudio.google.com), then try again.' } });
  await new Promise((r) => setTimeout(r, 900));
  return json(200, { ok: true, plan: fakePlan(JSON.parse(init.body)), model: 'mock' });
};
