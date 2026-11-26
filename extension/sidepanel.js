import { h, icon } from './ui.js';
import { ApiError, checkHealth, controlServer, serverIsCurrent } from './lib/api.js';
import { planWithAI, nameWithAI } from './lib/ai/index.js';
import { AI_KEY, isConfigured, loadAiConfig, PROVIDER_NAMES } from './lib/ai/config.js';
import { hasAccess, requestAccess, syncOriginRule } from './lib/ai/network.js';
import { createAiSettings } from './ai-settings.js';
import { snapshot, toApiTabs } from './lib/tabs.js';
import {
  describeActions, planCloseDuplicates, planCloseGroup, planGroupBySite, planSaveSession, planUngroupAll, planUngroupGroup, sanitizePlan,
} from './lib/plan.js';
import { applyPlan, describeResult, hasUndoableChanges, undoPlan } from './lib/actions.js';
import { createSessionsView } from './sessions-view.js';
import { isSessionKey } from './lib/sessions.js';
import { LINKS_KEY, unlinkAll } from './lib/tracker.js';

const $ = (id) => document.getElementById(id);
const els = {
  groups: $('groups'), groupsSection: $('groupsSection'),
  navOrganize: $('navOrganize'), navSessions: $('navSessions'), sessionsView: $('sessionsView'), composer: document.querySelector('.composer'),
  thread: $('thread'), welcome: $('welcome'), welcomeSub: $('welcomeSub'), presets: $('presets'), examples: $('examples'),
  form: $('form'), input: $('input'), send: $('send'), chips: $('chips'), status: $('status'), statusText: $('statusText'),
  aiBox: $('aiBox'), serverBox: $('serverBox'), aiState: $('aiState'), aiProvider: $('aiProvider'), aiHelp: $('aiHelp'), aiSave: $('aiSave'), aiResult: $('aiResult'),
  googleKey: $('googleKey'), googleModel: $('googleModel'), googleForget: $('googleForget'), ollamaUrl: $('ollamaUrl'), ollamaModel: $('ollamaModel'), ollamaModels: $('ollamaModels'), ollamaFind: $('ollamaFind'),
  openaiUrl: $('openaiUrl'), openaiKey: $('openaiKey'), openaiModel: $('openaiModel'), openaiForget: $('openaiForget'),
  serverState: $('serverState'), serverHelp: $('serverHelp'), restartBtn: $('restartBtn'), stopBtn: $('stopBtn'),
  settings: $('settings'), autoNameSessions: $('autoNameSessions'), liveSessions: $('liveSessions'), settingsBtn: $('settingsBtn'), resetBtn: $('resetBtn'), includePinned: $('includePinned'),
};

const COLOR_VAR = (c) => `var(--g-${c})`;
const UNDO_KEY = 'decltr.lastUndo';
const UNDO_MAX_AGE_MS = 30 * 60 * 1000;

const PRESETS = [
  {
    id: 'topic', icon: 'sparkles', title: 'Group by topic', desc: 'Smart groups with clear names', ai: true,
    prompt: 'Group my tabs by topic or task and give each group a short, clear name. Leave one-off tabs ungrouped. Do not close or move anything.',
  },
  { id: 'site', icon: 'globe', title: 'Group by site', desc: 'One group per website', local: planGroupBySite },
  { id: 'dupes', icon: 'copy', title: 'Close duplicates', desc: 'Keep one copy of each page', local: planCloseDuplicates },
  { id: 'session', icon: 'archive', title: 'Bookmark & clear', desc: 'Bookmark every tab, then close them', local: (tabs) => planSaveSession(tabs) },
  {
    id: 'leisure', icon: 'window', title: 'Split off leisure', desc: 'Video, social and shopping to a new window', ai: true,
    prompt: 'Move entertainment, video, social media and shopping tabs into a new window. Leave work and research tabs where they are.',
  },
  {
    id: 'tidy', icon: 'sliders', title: 'Full tidy-up', desc: 'Remove clutter, then group the rest', ai: true,
    prompt: 'Do a full tidy-up: close duplicate tabs and empty or error pages, then group the remaining tabs by topic.',
  },
  { id: 'ungroup', icon: 'ungroup', title: 'Ungroup all', desc: 'Dissolve every group, keep the tabs', local: planUngroupAll },
  {
    id: 'regroup', icon: 'reset', title: 'Regroup from scratch', desc: 'Ungroup everything, then group by topic', ai: true,
    prompt: 'Ungroup every tab that is currently in a tab group, then regroup all tabs by topic or task with fresh, clear names. Do not close or move anything.',
  },
];

const EXAMPLES = [
  'Bookmark all recipe tabs into a folder called Recipes and close them',
  'Put everything about my Lisbon trip in one group',
  'Close all tabs from news sites',
  'Move all video tabs to a new window',
  'Ungroup everything, then group by project',
];

const state = { busy: false, includePinned: false, autoNameSessions: true, liveSessions: true, hasThread: false, undoButton: null, health: 'checking', view: 'organize', serverInfo: null, serverBusy: false, confirmStop: false, ai: null, aiChosen: false };

const sessionsView = createSessionsView({
  els: {
    name: $('sessionName'), suggestBtn: $('suggestBtn'), saveBox: $('saveBox'), saveBtn: $('saveBtn'), saveClearBtn: $('saveClearBtn'), saveInfo: $('saveInfo'),
    status: $('sessionStatus'), list: $('sessionList'), empty: $('sessionsEmpty'), count: $('sessionCount'),
  },
  getAiConfig: () => state.ai,
  getSettings: () => ({ includePinned: state.includePinned, autoNameSessions: state.autoNameSessions, liveSessions: state.liveSessions }),
});

/* ------------------------------------------------------------------ setup */

async function init() {
  state.ai = await loadAiConfig();
  state.aiChosen = AI_KEY in (await chrome.storage.local.get(AI_KEY));
  await syncOriginRule(state.ai).catch(() => {});
  const saved = await chrome.storage.local.get({ includePinned: false, autoNameSessions: true, liveSessions: true });
  state.includePinned = saved.includePinned;
  state.autoNameSessions = saved.autoNameSessions;
  state.liveSessions = saved.liveSessions;
  els.includePinned.checked = state.includePinned;
  els.autoNameSessions.checked = state.autoNameSessions;
  els.liveSessions.checked = state.liveSessions;

  aiSettings.render();
  els.settingsBtn.append(icon('sliders'));
  els.resetBtn.append(icon('reset'));
  els.send.append(icon('send', 18));
  renderPresets();
  renderExamples();
  wireEvents();
  sessionsView.renderList();
  updateTabCount();
  restoreUndoBanner();
  refreshHealth();
  autosize();
}

const aiSettings = createAiSettings({
  els: {
    provider: els.aiProvider, help: els.aiHelp, save: els.aiSave, result: els.aiResult, state: els.aiState,
    googleKey: els.googleKey, googleModel: els.googleModel, googleForget: els.googleForget,
    ollamaUrl: els.ollamaUrl, ollamaModel: els.ollamaModel, ollamaModels: els.ollamaModels, ollamaFind: els.ollamaFind,
    openaiUrl: els.openaiUrl, openaiKey: els.openaiKey, openaiModel: els.openaiModel, openaiForget: els.openaiForget,
  },
  getConfig: () => state.ai,
  onSaved(config) {
    state.ai = config;
    state.aiChosen = true;
    els.welcome.querySelector('[data-setup]')?.remove();
    refreshHealth();
  },
});

function wireEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitText();
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitText();
    }
  });
  els.input.addEventListener('input', autosize);

  els.settingsBtn.addEventListener('click', () => {
    const open = els.settings.hidden;
    els.settings.hidden = !open;
    els.settingsBtn.setAttribute('aria-expanded', String(open));
  });
  els.includePinned.addEventListener('change', async () => {
    state.includePinned = els.includePinned.checked;
    await chrome.storage.local.set({ includePinned: state.includePinned });
    updateTabCount();
    if (state.view === 'sessions') sessionsView.refreshSaveBox();
  });
  els.resetBtn.addEventListener('click', resetThread);
  els.restartBtn.addEventListener('click', () => controlService('restart'));
  els.stopBtn.addEventListener('click', () => controlService('stop'));
  els.navOrganize.addEventListener('click', () => showView('organize'));
  els.navSessions.addEventListener('click', () => showView('sessions'));
  // Sessions live in browser storage, so every window's panel stays in sync.
  chrome.storage.onChanged.addListener((changes, area) => {
    const sessionsChanged = area === 'local' && Object.keys(changes).some(isSessionKey);
    const linksChanged = area === 'session' && changes[LINKS_KEY];
    if (sessionsChanged || linksChanged) sessionsView.renderList();
  });
  els.autoNameSessions.addEventListener('change', async () => {
    state.autoNameSessions = els.autoNameSessions.checked;
    await chrome.storage.local.set({ autoNameSessions: state.autoNameSessions });
  });
  els.liveSessions.addEventListener('change', async () => {
    state.liveSessions = els.liveSessions.checked;
    await chrome.storage.local.set({ liveSessions: state.liveSessions });
    // Switching it off forgets which windows were following sessions, so switching it on never resumes old ones.
    if (!state.liveSessions) await unlinkAll();
    sessionsView.renderList({ force: true });
  });
  els.status.addEventListener('click', () => {
    if (state.health === 'setup') openSettings();
    refreshHealth();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshHealth();
      updateTabCount();
    }
  });

  let timer;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(updateTabCount, 300);
  };
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onAttached', 'onDetached']) chrome.tabs[ev].addListener(soon);
  for (const ev of ['onCreated', 'onUpdated', 'onRemoved']) chrome.tabGroups[ev].addListener(soon);
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
  els.send.disabled = state.busy || els.input.value.trim() === '';
}

/* ----------------------------------------------------------------- welcome */

function renderPresets() {
  els.presets.replaceChildren(
    ...PRESETS.map((p) =>
      h('button', { class: 'preset', type: 'button', 'data-id': p.id, onClick: () => run({ label: p.title, preset: p }) },
        h('div', { class: 'preset-head' }, icon(p.icon, 20), h('span', { class: `badge${p.local ? ' local' : ''}` }, p.local ? 'On-device' : 'AI')),
        h('b', null, p.title),
        h('span', { class: 'desc' }, p.desc),
      ),
    ),
  );
}

function renderExamples() {
  els.examples.replaceChildren(
    ...EXAMPLES.map((text) =>
      h('button', {
        class: 'example', type: 'button',
        onClick: () => {
          els.input.value = text;
          autosize();
          els.input.focus();
        },
      }, `“${text}”`),
    ),
  );
}

async function updateTabCount() {
  try {
    const snap = await snapshot({ includePinned: state.includePinned });
    const hidden = snap.pinnedCount > 0 && !state.includePinned ? ` (${snap.pinnedCount} pinned left alone)` : '';
    els.welcomeSub.textContent = `${snap.total} tab${snap.total === 1 ? '' : 's'} in this window${hidden}. Pick a quick action or describe what you want.`;
    renderGroups(snap);
    if (state.view === 'sessions') sessionsView.refreshSaveBox();
  } catch {
    /* panel is closing */
  }
}

function showView(view) {
  state.view = view;
  const sessions = view === 'sessions';
  els.thread.hidden = sessions;
  els.composer.hidden = sessions;
  els.sessionsView.hidden = !sessions;
  els.navOrganize.setAttribute('aria-selected', String(!sessions));
  els.navSessions.setAttribute('aria-selected', String(sessions));
  if (sessions) sessionsView.refresh();
}

/** One row per tab group, with direct controls. Both buttons produce a plan you can review and undo. */
function renderGroups(snap) {
  const rows = [];
  for (const g of snap.groups.values()) {
    const count = snap.tabs.filter((t) => t.groupId === g.id).length;
    if (count === 0) continue;
    const name = g.title || 'Unnamed group';
    rows.push(
      h('li', { class: 'group-row' },
        h('span', { class: 'swatch', style: { background: COLOR_VAR(g.color) } }),
        h('span', { class: 'group-name', title: name }, name),
        h('span', { class: 'group-count', title: `${count} tab${count === 1 ? '' : 's'}` }, String(count)),
        h('button', {
          class: 'btn small', type: 'button', disabled: state.busy, title: 'Remove the group but keep its tabs',
          'aria-label': `Ungroup ${name}, keep its tabs`,
          onClick: () => run({ label: `Ungroup \u201c${name}\u201d`, preset: { local: (tabs) => planUngroupGroup(tabs, g.id, g.title) } }),
        }, 'Ungroup'),
        h('button', {
          class: 'btn small danger-ghost', type: 'button', disabled: state.busy, title: 'Close the group and all its tabs',
          'aria-label': `Close group ${name} and its tabs`,
          onClick: () => run({ label: `Close \u201c${name}\u201d`, preset: { local: (tabs) => planCloseGroup(tabs, g.id, g.title) } }),
        }, 'Close'),
      ),
    );
  }
  els.groups.replaceChildren(...rows);
  els.groupsSection.hidden = rows.length === 0;
}

function resetThread() {
  if (state.busy) return;
  els.thread.replaceChildren(els.welcome);
  els.welcome.hidden = false;
  state.hasThread = false;
  state.undoButton = null;
  els.chips.hidden = true;
  els.resetBtn.hidden = true;
  updateTabCount();
  restoreUndoBanner();
  if (state.health !== 'ok') refreshHealth();
}

function enterThread() {
  if (state.hasThread) return;
  state.hasThread = true;
  els.welcome.hidden = true;
  els.resetBtn.hidden = false;
  els.chips.hidden = false;
  els.chips.replaceChildren(
    ...PRESETS.map((p) => h('button', { class: 'chip', type: 'button', onClick: () => run({ label: p.title, preset: p }) }, p.title)),
  );
  // Remove the leftover "undo last session" banner, if any, once the user moves on.
  els.thread.querySelectorAll('[data-restored]').forEach((n) => n.remove());
}

function add(node) {
  els.thread.append(node);
  els.thread.scrollTop = els.thread.scrollHeight;
  return node;
}

/* ------------------------------------------------------------------- run */

function submitText() {
  const text = els.input.value.trim();
  if (!text || state.busy) return;
  els.input.value = '';
  autosize();
  run({ label: text, instruction: text });
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('.preset, .chip, .group-row .btn').forEach((b) => (b.disabled = busy));
  autosize();
}

async function run({ label, preset, instruction }) {
  if (state.busy) return;
  setBusy(true);
  enterThread();
  add(h('div', { class: 'me' }, label));

  let thinking;
  try {
    const snap = await snapshot({ includePinned: state.includePinned });
    if (snap.tabs.length === 0) {
      add(h('div', { class: 'bot-text' }, 'There are no tabs to organize here. Pinned tabs are left alone unless you turn them on in settings.'));
      return;
    }

    let raw;
    if (preset?.local) {
      raw = preset.local(snap.tabs);
    } else {
      const blocked = await aiBlocker();
      if (blocked) {
        add(blocked);
        return;
      }
      thinking = add(thinkingCard());
      raw = await planWithAI({ instruction: instruction ?? preset.prompt, tabs: toApiTabs(snap) }, state.ai);
      if (state.ai.provider === 'server' && state.health !== 'outdated') setHealth('ok');
    }
    thinking?.remove();

    const plan = sanitizePlan(raw, snap.byId);
    if (plan.actions.length === 0) {
      add(h('div', { class: 'bot-text' }, plan.message || raw?.message || 'Nothing to do for that request.'));
      return;
    }
    add(planCard(plan, snap, { label, preset, instruction }));
  } catch (err) {
    thinking?.remove();
    add(errorCard(err, { label, preset, instruction }));
    if (err instanceof ApiError && (err.code === 'offline' || err.code === 'no_key')) refreshHealth();
  } finally {
    setBusy(false);
  }
}

function thinkingCard() {
  return h('div', { class: 'thinking', role: 'status' },
    h('div', { class: 'label' }, icon('sparkles'), 'Reading your tabs…'),
    h('div', { class: 'shimmer', style: { width: '90%' } }),
    h('div', { class: 'shimmer', style: { width: '70%' } }),
    h('div', { class: 'shimmer', style: { width: '80%' } }),
  );
}

/* --------------------------------------------------------------- plan card */

function planCard(plan, snap, again) {
  // Mutable working copy so the user can switch actions off or drop single tabs.
  const items = plan.actions.map((a) => ({ ...a, tabIds: [...a.tabIds], enabled: true, open: false }));
  const card = h('section', { class: 'card' });
  let applying = false;

  const activeItems = () => items.filter((i) => i.enabled && i.tabIds.length > 0);
  const closeCount = () => new Set(activeItems().filter((i) => i.type === 'close').flatMap((i) => i.tabIds)).size;

  function render() {
    const active = activeItems();
    const closing = closeCount();
    const list = h('ul', { class: 'actions' }, items.map((item, idx) => actionRow(item, idx)));
    const apply = h('button', {
      class: 'btn primary', type: 'button', disabled: active.length === 0 || applying,
      onClick: doApply,
    }, icon('check', 16), active.length === 0 ? 'Nothing selected' : `Apply ${active.length} change${active.length === 1 ? '' : 's'}`);

    card.replaceChildren(
      ...[
        h('div', { class: 'card-head' },
          h('div', { class: 'title' }, icon('sparkles', 16), 'Here is my plan'),
          h('p', null, plan.summary || describeActions(active)),
        ),
        list,
        // replaceChildren turns null into the text "null", so optional parts are filtered out.
        closing ? h('div', { class: 'warn' }, icon('alert', 16), `Closes ${closing} tab${closing === 1 ? '' : 's'}. You can undo it afterwards.`) : null,
        h('div', { class: 'card-foot' }, apply, h('button', { class: 'btn ghost', type: 'button', disabled: applying, onClick: () => card.remove() }, 'Dismiss')),
      ].filter(Boolean),
    );
  }

  function actionRow(item, idx) {
    const n = item.tabIds.length;
    const dead = n === 0;
    const title =
      item.type === 'group' ? [h('span', { class: 'swatch', style: { background: COLOR_VAR(item.color) } }), h('span', { class: 'name' }, item.name)]
      : item.type === 'ungroup' ? [h('span', { class: 'name' }, `Ungroup ${n} tab${n === 1 ? '' : 's'}`)]
      : item.type === 'close' ? [h('span', { class: 'name' }, `Close ${n} tab${n === 1 ? '' : 's'}`)]
      : item.type === 'move_to_new_window' ? [h('span', { class: 'name' }, 'Move to a new window')]
      : [h('span', { class: 'name' }, `Bookmark to “${item.folder}”`)];
    const iconName = { group: 'group', ungroup: 'ungroup', close: 'x', move_to_new_window: 'window', bookmark: 'bookmark' }[item.type];
    const from = item.type === 'ungroup' ? `from ${groupNamesOf(item)}` : null;
    const sub = [`${n} tab${n === 1 ? '' : 's'}`, from, item.reason].filter(Boolean).join(' · ');
    const enabled = item.enabled && !dead;

    return h('li', { class: `action kind-${item.type === 'move_to_new_window' ? 'move' : item.type}${enabled ? '' : ' off'}` },
      h('div', { class: 'action-row' },
        h('input', {
          class: 'check', type: 'checkbox', checked: enabled, disabled: dead || applying,
          'aria-label': `Include: ${item.type}`,
          onChange: (e) => { item.enabled = e.target.checked; render(); },
        }),
        h('span', { class: 'badge-ico' }, icon(iconName, 16)),
        h('div', { class: 'action-main' }, h('div', { class: 'action-title' }, title), h('div', { class: 'action-sub' }, sub)),
        h('button', {
          class: 'expand', type: 'button', 'aria-expanded': String(item.open), 'aria-label': 'Show tabs',
          onClick: () => { item.open = !item.open; render(); },
        }, icon('chevron', 16)),
      ),
      item.open ? h('ul', { class: 'tab-list' }, item.tabIds.map((id) => tabRow(item, id, idx))) : null,
    );
  }

  function groupNamesOf(item) {
    const names = new Set(item.tabIds.map((id) => snap.groups.get(snap.byId.get(id)?.groupId)?.title || 'an unnamed group'));
    return [...names].join(', ');
  }

  function tabRow(item, id) {
    const tab = snap.byId.get(id);
    const fav = h('img', { class: 'fav', alt: '', src: tab?.favIconUrl || null, referrerpolicy: 'no-referrer', onError: (e) => e.target.removeAttribute('src') });
    return h('li', { class: 'tab-item', title: tab?.url ?? '' },
      fav,
      h('span', { class: 'tab-title' }, tab?.title ?? `Tab ${id}`),
      h('button', {
        class: 'tab-remove', type: 'button', 'aria-label': `Leave out ${tab?.title ?? 'tab'}`,
        onClick: () => { item.tabIds = item.tabIds.filter((t) => t !== id); render(); },
      }, icon('x', 14)),
    );
  }

  async function doApply() {
    applying = true;
    render();
    const finalPlan = { actions: activeItems().map(({ enabled, open, ...a }) => a) };
    try {
      const result = await applyPlan(finalPlan, { windowId: snap.windowId });
      await rememberUndo(result);
      card.replaceWith(resultCard(result));
    } catch (err) {
      applying = false;
      card.replaceWith(errorCard(err, again));
    }
    updateTabCount();
    els.thread.scrollTop = els.thread.scrollHeight;
  }

  render();
  return card;
}

/* ------------------------------------------------------------ result / undo */

function resultCard(result, { restored = false } = {}) {
  const undoable = hasUndoableChanges(result);
  const text = h('div', { class: 'text' }, h('b', null, describeResult(result)), result.notes?.length ? h('small', null, result.notes.join(' ')) : null);
  const node = h('div', { class: 'result', 'data-restored': restored ? '' : null }, icon('check', 20), text);

  if (undoable) {
    const btn = h('button', { class: 'btn', type: 'button' }, icon('undo', 15), 'Undo');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await undoPlan(result.undo);
        await chrome.storage.session.remove(UNDO_KEY);
        node.classList.add('undone');
        node.replaceChildren(icon('undo', 20), h('div', { class: 'text' }, h('b', null, 'Undone'), h('small', null, 'Your tabs are back as they were.')));
      } catch {
        btn.disabled = false;
      }
      updateTabCount();
    });
    if (state.undoButton && state.undoButton !== btn) {
      state.undoButton.disabled = true;
      state.undoButton.title = 'Only the most recent change can be undone';
    }
    state.undoButton = btn;
    node.append(btn);
  }
  return node;
}

async function rememberUndo(result) {
  if (!hasUndoableChanges(result)) return;
  await chrome.storage.session.set({ [UNDO_KEY]: { result, savedAt: Date.now() } });
}

async function restoreUndoBanner() {
  const win = await chrome.windows.getCurrent();
  const saved = (await chrome.storage.session.get(UNDO_KEY))[UNDO_KEY];
  if (!saved || Date.now() - saved.savedAt > UNDO_MAX_AGE_MS || saved.result.undo.windowId !== win.id) return;
  if (state.hasThread || els.thread.querySelector('[data-restored]')) return;
  const node = resultCard(saved.result, { restored: true });
  node.querySelector('.text small')?.remove();
  node.querySelector('.text').append(h('small', null, 'Your last change in this window.'));
  els.thread.insertBefore(node, els.thread.firstChild);
}

/* ------------------------------------------------------------------- errors */

function errorCard(err, again) {
  const code = typeof err?.code === 'string' ? err.code : 'error';
  const server = state.ai?.provider === 'server';
  if (code === 'not_configured') return chooserCard();
  if (server && code === 'offline') return state.aiChosen ? setupCard('offline') : chooserCard();
  if (server && code === 'no_key') return setupCard('no_key');

  // Messages from the model layer, the server and the request checks are written to be read by a person.
  const known = err instanceof ApiError || err instanceof Error && typeof err.code === 'string';
  const message = known && err.message ? err.message : 'Something went wrong while changing your tabs.';
  return h('div', { class: 'banner error' },
    h('h3', null, icon('alert', 16), 'That did not work'),
    h('p', null, message),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onClick: (e) => { e.target.closest('.banner').remove(); run(again); } }, 'Try again'),
    ),
  );
}

function copyButton(text) {
  const btn = h('button', { class: 'icon-btn', type: 'button', title: 'Copy', 'aria-label': `Copy ${text}` }, icon('copy', 15));
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text).catch(() => {});
    btn.replaceChildren(icon('check', 15));
    setTimeout(() => btn.replaceChildren(icon('copy', 15)), 1200);
  });
  return btn;
}

function setupCard(kind) {
  const offline = kind === 'offline';
  const cmd = offline ? 'npm start' : 'npm run set-key';
  return h('div', { class: 'banner', 'data-setup': '' },
    h('h3', null, icon(offline ? 'plug' : 'key', 16), offline ? 'The Decltr server is not running' : 'Add your API key'),
    h('p', null, offline
      ? 'AI actions need the small helper app on your computer. It keeps your API key safe. On-device actions work without it.'
      : 'The server is running but has no API key yet. It stores the key in your macOS Keychain.'),
    h('ol', null,
      h('li', null, 'Open Terminal in the declt folder.'),
      h('li', null, 'Run this command:'),
    ),
    h('div', { class: 'code' }, h('span', null, cmd), copyButton(cmd)),
    offline ? h('p', null, 'To have it run in the background and start at login, run npm run server:install once.') : null,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onClick: refreshHealth }, 'Check again')),
  );
}

/* ------------------------------------------------------------------- health */

function setHealth(kind) {
  state.health = kind;
  const map = { ok: 'Ready', warn: 'No API key', setup: 'Set up AI', off: 'Server offline', outdated: 'Restart server', checking: 'Checking' };
  els.status.title = kind === 'ok' && state.ai?.provider !== 'server' ? `Using ${PROVIDER_NAMES[state.ai.provider]}` : kind === 'setup' ? 'Choose which AI model Decltr should use.' : kind === 'outdated' ? 'The running Decltr server is older than this extension. Restart it: Settings, Server, Restart (or run npm run server:restart).' : '';
  els.status.dataset.state = kind;
  els.statusText.textContent = map[kind];
  els.status.setAttribute('aria-label', `AI status: ${map[kind]}. Click to re-check.`);
}

async function refreshHealth() {
  setHealth('checking');
  aiSettings.renderState();
  // A model that runs from the extension has no server to ask. It is ready when it is set up and Chrome allows the address.
  if (state.ai.provider !== 'server') {
    state.serverInfo = null;
    const ready = isConfigured(state.ai) && (await hasAccess(state.ai));
    setHealth(ready ? 'ok' : 'setup');
    renderServerBox();
    showWelcomeSetup(ready ? null : isConfigured(state.ai) ? accessCard() : chooserCard());
    return;
  }
  try {
    const info = await checkHealth();
    state.serverInfo = info;
    setHealth(!info.keyConfigured ? 'warn' : serverIsCurrent(info) ? 'ok' : 'outdated');
  } catch {
    state.serverInfo = null;
    setHealth('off');
  }
  renderServerBox();
  // Keep a setup hint visible on the welcome screen when AI is not usable.
  const needsHelp = state.health !== 'ok' && state.health !== 'checking' && state.health !== 'outdated';
  // Someone who has not chosen a model yet gets the choices, not instructions for one particular server.
  const card = !needsHelp ? null : state.health === 'off' ? (state.aiChosen ? setupCard('offline') : chooserCard()) : setupCard('no_key');
  showWelcomeSetup(card);
}

function showWelcomeSetup(card) {
  els.welcome.querySelector('[data-setup]')?.remove();
  if (card && !state.hasThread) els.welcome.insertBefore(card, els.presets);
}

/* ------------------------------------------------------------------ choosing a model */

function openSettings(provider) {
  els.settings.hidden = false;
  els.settingsBtn.setAttribute('aria-expanded', 'true');
  if (provider) aiSettings.choose(provider);
  els.aiBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Shown when no model is set up. Picking one opens its settings, which is where the details are entered. */
function chooserCard() {
  const choice = (provider, title, text) =>
    h('button', { class: 'choice', type: 'button', onClick: () => openSettings(provider) }, h('b', null, title), h('span', null, text));
  return h('div', { class: 'banner', 'data-setup': '' },
    h('h3', null, icon('sparkles', 16), 'Choose how Decltr should think'),
    h('p', null, 'AI actions need a model. Quick actions marked On-device work without one.'),
    choice('google', 'Google Gemini', 'Paste an API key. Nothing to install.'),
    choice('ollama', 'Ollama', 'Runs on your computer. Nothing leaves it.'),
    choice('openai', 'Another service', 'OpenAI, OpenRouter, Groq, LM Studio and others.'),
  );
}

/** The chosen address has not been allowed in Chrome yet. Chrome only asks while handling a click, hence the button. */
function accessCard() {
  const where = new URL(state.ai[state.ai.provider === 'ollama' ? 'ollama' : 'openai'].baseUrl ?? 'https://x.invalid').origin;
  const card = h('div', { class: 'banner', 'data-setup': '' },
    h('h3', null, icon('plug', 16), 'Allow Decltr to reach your model'),
    h('p', null, `Chrome needs your permission before Decltr can contact ${state.ai.provider === 'google' ? 'Google' : where}.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onClick: async () => {
        if (await requestAccess(state.ai)) {
          await syncOriginRule(state.ai);
          card.remove();
          refreshHealth();
        }
      } }, 'Allow'),
      h('button', { class: 'btn', type: 'button', onClick: () => openSettings() }, 'Settings'),
    ),
  );
  return card;
}

/** Returns a card to show instead of running an AI action, or null when the chosen model is ready. */
async function aiBlocker() {
  if (state.ai.provider === 'server') return null;
  if (!isConfigured(state.ai)) return chooserCard();
  if (!(await hasAccess(state.ai))) return accessCard();
  return null;
}

/* ------------------------------------------------------------ server controls */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the Server section of the settings says and which buttons work. */
function renderServerBox(message) {
  els.serverBox.hidden = state.ai.provider !== 'server';
  const info = state.serverInfo;
  const managed = Boolean(info?.managed);
  let text;
  let help;
  if (!info) {
    text = 'Not running';
    help = 'Start it with <code>npm run server:start</code> (background service) or <code>npm start</code> (this terminal only).';
  } else if (managed) {
    text = `Running in the background · v${info.version}`;
    help = 'Restart reloads it. Stop keeps it off until you start it again with <code>npm run server:start</code>.';
  } else {
    text = `Running from a terminal · v${info.version}`;
    help = 'To control it from here, set it up as a background service: <code>npm run server:install -- --replace</code>';
  }
  els.serverState.textContent = message ?? text;
  els.serverHelp.innerHTML = message ? '' : help; // fixed strings above, never page data
  els.restartBtn.disabled = !managed || state.serverBusy;
  els.stopBtn.disabled = !managed || state.serverBusy;
}

async function controlService(action) {
  if (state.serverBusy || !state.serverInfo?.managed) return;
  if (action === 'stop' && !state.confirmStop) {
    // Stopping cannot be undone from here (nothing is left to talk to), so ask once.
    state.confirmStop = true;
    els.stopBtn.textContent = 'Stop it?';
    setTimeout(() => {
      state.confirmStop = false;
      els.stopBtn.textContent = 'Stop';
    }, 3000);
    return;
  }
  state.confirmStop = false;
  els.stopBtn.textContent = 'Stop';
  state.serverBusy = true;
  const oldPid = state.serverInfo.pid;
  renderServerBox(action === 'restart' ? 'Restarting…' : 'Stopping…');
  try {
    await controlServer(action);
    if (action === 'stop') {
      await wait(1200);
      state.serverInfo = null;
      setHealth('off');
      state.serverBusy = false;
      renderServerBox('Stopped. Start it again with npm run server:start');
      return;
    }
    // Restart: wait for a new process to answer.
    for (let i = 0; i < 30; i++) {
      await wait(500);
      try {
        const info = await checkHealth();
        if (info.pid !== oldPid) {
          state.serverInfo = info;
          setHealth(!info.keyConfigured ? 'warn' : serverIsCurrent(info) ? 'ok' : 'outdated');
          state.serverBusy = false;
          renderServerBox();
          return;
        }
      } catch {
        /* still restarting */
      }
    }
    throw new Error('It did not come back within 15 seconds. Check the log: npm run server:logs');
  } catch (err) {
    state.serverBusy = false;
    await refreshHealth();
    renderServerBox(err instanceof ApiError || err instanceof Error ? err.message : 'That did not work.');
  }
}

init();
