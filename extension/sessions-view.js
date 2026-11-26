import { h, icon } from './ui.js';
import { snapshot } from './lib/tabs.js';
import { nameWithAI } from './lib/ai/index.js';
import { undoPlan } from './lib/actions.js';
import {
  buildSession, defaultSessionName, describeSession, loadSessions, renameSession, saveableTabs, saveSession,
} from './lib/sessions.js';
import { autoNameInBackground, clearSavedTabs, openTracked, removeSession, undoTrackedOpen } from './lib/session-ops.js';
import { getLinks, unlinkSession } from './lib/tracker.js';

const COLOR_VAR = (c) => `var(--g-${c})`;
const formatDate = (ms) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

/** What the naming endpoint needs to know about a saved session's tabs. */
const nameInput = (session) => session.tabs.map((t) => ({ title: t.title, url: t.url, group: t.g >= 0 ? session.groups[t.g]?.title : undefined }));

/** The "Sessions" tab: save this window, name sessions, and open them in any window. */
export function createSessionsView({ els, getSettings, getAiConfig }) {
  const suggestName = (tabs) => nameWithAI(tabs, getAiConfig());
  const state = { busy: false, nameEdited: false, confirmId: null, confirmTimer: null, expanded: new Set(), editingId: null, lastSig: '', deferred: false };

  const windowSnapshot = () => snapshot({ includePinned: getSettings().includePinned, limit: Infinity });

  els.name.addEventListener('input', () => (state.nameEdited = els.name.value.trim() !== ''));
  els.saveBox.addEventListener('submit', (e) => {
    e.preventDefault();
    save({ clear: false });
  });
  els.saveClearBtn.addEventListener('click', () => save({ clear: true }));
  els.suggestBtn.append(icon('sparkles', 16));
  els.suggestBtn.addEventListener('click', suggestForWindow);

  /* ------------------------------------------------------------ save box */

  async function refreshSaveBox() {
    const snap = await windowSnapshot();
    const session = buildSession({ name: 'x', tabs: snap.tabs, groups: snap.groups });
    const n = session.tabs.length;
    const g = session.groups.length;
    els.saveInfo.textContent = n
      ? `${n} tab${n === 1 ? '' : 's'}${g ? ` and ${g} group${g === 1 ? '' : 's'}` : ''} in this window will be saved.`
      : 'This window has no pages to save yet.';
    setSaveDisabled(state.busy || n === 0);
    if (!state.nameEdited && document.activeElement !== els.name) els.name.value = defaultSessionName();
  }

  function setSaveDisabled(disabled) {
    els.saveBtn.disabled = disabled;
    els.saveClearBtn.disabled = disabled;
    els.suggestBtn.disabled = disabled;
  }

  function setBusy(busy) {
    state.busy = busy;
    setSaveDisabled(busy);
    els.list.querySelectorAll('.session .btn').forEach((b) => (b.disabled = busy));
  }

  /** The sparkle next to the name box: ask the AI what to call this window. */
  async function suggestForWindow() {
    if (state.busy) return;
    els.status.replaceChildren(); // a new attempt replaces any earlier message
    els.suggestBtn.disabled = true;
    els.suggestBtn.classList.add('working');
    try {
      const snap = await windowSnapshot();
      const session = buildSession({ name: 'x', tabs: snap.tabs, groups: snap.groups });
      if (session.tabs.length === 0) return setStatus({ error: 'There is nothing in this window to name yet.' });
      els.name.value = await suggestName(nameInput(session));
      state.nameEdited = true;
    } catch (err) {
      setStatus({ error: err?.message ?? 'Could not suggest a name.' });
    } finally {
      els.suggestBtn.classList.remove('working');
      els.suggestBtn.disabled = state.busy;
    }
  }

  async function save({ clear }) {
    if (state.busy) return;
    setBusy(true);
    try {
      const snap = await windowSnapshot();
      const tabs = saveableTabs(snap.tabs);
      if (tabs.length === 0) return setStatus({ error: 'There is nothing to save in this window.' });

      const typed = els.name.value.trim();
      // The pre-filled date is a placeholder, not a name the user chose.
      const chosen = state.nameEdited && typed ? typed : '';
      const session = buildSession({ name: chosen, nameSource: 'user', tabs: snap.tabs, groups: snap.groups });
      await saveSession(session);
      state.nameEdited = false;
      els.name.value = '';

      // Name it with AI in the background so saving never waits on the network.
      if (getSettings().autoNameSessions && session.nameSource === 'default') autoNameInBackground(session, suggestName);

      if (!clear) {
        return setStatus({ text: `Saved “${session.name}”`, sub: `${describeSession(session)}. Open it from any window.` });
      }
      // Close exactly the tabs that were saved. Anything that could not be saved stays open.
      const result = await clearSavedTabs({ windowId: snap.windowId, tabIds: tabs.map((t) => t.id) });
      setStatus({
        text: `Saved “${session.name}” and cleared the window`,
        sub: [describeSession(session), ...result.notes].join('. '),
        undo: () => undoPlan(result.undo),
      });
    } catch (err) {
      setStatus({ error: err?.message ?? 'Could not save the session.' });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  /* ------------------------------------------------------------- status */

  function setStatus(status) {
    if (status.error) {
      els.status.replaceChildren(
        h('div', { class: 'banner error' }, h('h3', null, icon('alert', 16), 'That did not work'), h('p', null, status.error)),
      );
      return;
    }
    const node = h('div', { class: 'result' },
      icon('check', 20),
      h('div', { class: 'text' }, h('b', null, status.text), status.sub ? h('small', null, status.sub) : null),
    );
    if (status.undo) {
      const btn = h('button', { class: 'btn', type: 'button' }, icon('undo', 15), 'Undo');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await status.undo();
          node.classList.add('undone');
          node.replaceChildren(icon('undo', 20), h('div', { class: 'text' }, h('b', null, 'Undone')));
        } catch {
          btn.disabled = false;
        }
        refresh();
      });
      node.append(btn);
    }
    els.status.replaceChildren(node);
  }

  /* --------------------------------------------------------------- list */

  /** Sessions that currently have an open window following them. */
  async function liveSessionIds() {
    if (!getSettings().liveSessions) return new Set();
    const open = new Set((await chrome.windows.getAll()).map((w) => w.id));
    return new Set(Object.entries(await getLinks()).filter(([w]) => open.has(Number(w))).map(([, id]) => id));
  }

  async function renderList({ force = false } = {}) {
    // Never rebuild the list under someone who is typing a new name.
    if (state.editingId && !force) {
      state.deferred = true;
      return;
    }
    const [sessions, live] = await Promise.all([loadSessions(), liveSessionIds()]);
    els.count.textContent = String(sessions.length);
    els.count.hidden = sessions.length === 0;
    els.empty.hidden = sessions.length > 0;

    // Live sessions change often; skip the rebuild when nothing visible changed.
    const sig = JSON.stringify([sessions.map((s) => [s.id, s.name, s.updatedAt, s.tabs.length, live.has(s.id)]), [...state.expanded], state.confirmId, state.busy]);
    if (sig === state.lastSig && !force) return;
    state.lastSig = sig;
    state.deferred = false;
    els.list.replaceChildren(...sessions.map((s) => sessionCard(s, live.has(s.id))));
  }

  function sessionCard(session, isLive) {
    const expanded = state.expanded.has(session.id);
    const confirming = state.confirmId === session.id;
    const shown = session.tabs.slice(0, 8);

    return h('li', { class: 'session' },
      h('div', { class: 'session-main' },
        state.editingId === session.id ? renameForm(session) : titleRow(session),
        h('div', { class: 'session-meta' }, `${describeSession(session)} · ${formatDate(isLive ? session.updatedAt : session.createdAt)}`),
        isLive
          ? h('div', { class: 'live-row' },
            h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'live-text' }, 'Live: changes in its window are saved'),
            h('button', { class: 'link-btn', type: 'button', onClick: () => stopSyncing(session) }, 'Stop syncing'),
          )
          : null,
        h('div', { class: 'favs', 'aria-hidden': 'true' },
          shown.map((t) => h('img', { class: 'fav', alt: '', src: t.favIcon || null, referrerpolicy: 'no-referrer', onError: (e) => e.target.removeAttribute('src') })),
          session.tabs.length > shown.length ? h('span', { class: 'more' }, `+${session.tabs.length - shown.length}`) : null,
        ),
      ),
      h('div', { class: 'session-actions' },
        h('button', {
          class: 'btn primary', type: 'button', disabled: state.busy,
          'aria-label': isLive ? `Go to the window of ${session.name}` : `Open ${session.name} in a new window`,
          title: isLive ? 'This session is already open. Switch to its window.' : 'Open in a new window',
          onClick: () => openIt(session, 'new'),
        }, icon('newWindow', 15), isLive ? 'Go to window' : 'New window'),
        h('button', {
          class: 'btn', type: 'button', disabled: state.busy, title: 'Add these tabs to the current window', 'aria-label': `Open ${session.name} in this window`,
          onClick: () => openIt(session, 'here'),
        }, icon('here', 15), 'This window'),
        h('button', {
          class: 'icon-btn expand', type: 'button', 'aria-expanded': String(expanded), 'aria-label': `Show tabs in ${session.name}`, title: 'Show tabs',
          onClick: () => {
            if (expanded) state.expanded.delete(session.id);
            else state.expanded.add(session.id);
            renderList({ force: true });
          },
        }, icon('chevron', 16)),
        h('button', {
          class: `icon-btn${confirming ? ' confirm' : ''}`, type: 'button',
          'aria-label': confirming ? `Confirm: delete ${session.name}` : `Delete ${session.name}`, title: confirming ? 'Click again to delete' : 'Delete session',
          onClick: () => (confirming ? remove(session) : armDelete(session.id)),
        }, confirming ? 'Delete?' : icon('trash', 16)),
      ),
      expanded ? tabList(session) : null,
    );
  }

  function titleRow(session) {
    return h('div', { class: 'title-row' },
      h('div', { class: 'session-name' }, session.name),
      h('button', {
        class: 'icon-btn small', type: 'button', title: 'Rename', 'aria-label': `Rename ${session.name}`,
        onClick: () => {
          state.editingId = session.id;
          renderList({ force: true }).then(() => els.list.querySelector('.rename input')?.select());
        },
      }, icon('pencil', 14)),
    );
  }

  /** Inline rename: Enter saves, Escape cancels, the sparkle asks the AI for a name. */
  function renameForm(session) {
    const input = h('input', { type: 'text', maxlength: '60', value: session.name, 'aria-label': 'Session name' });
    const stop = async () => {
      state.editingId = null;
      await renderList({ force: true });
    };
    const commit = async () => {
      const name = input.value.trim();
      if (name && name !== session.name) await renameSession(session.id, name);
      await stop();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
      }
    });
    const suggest = h('button', { class: 'icon-btn small', type: 'button', title: 'Suggest a name with AI', 'aria-label': 'Suggest a name with AI' }, icon('sparkles', 14));
    suggest.addEventListener('click', async () => {
      els.status.replaceChildren();
      suggest.disabled = true;
      suggest.classList.add('working');
      try {
        input.value = await suggestName(nameInput(session));
        input.focus();
      } catch (err) {
        setStatus({ error: err?.message ?? 'Could not suggest a name.' });
      } finally {
        suggest.classList.remove('working');
        suggest.disabled = false;
      }
    });
    return h('form', { class: 'rename', onSubmit: (e) => (e.preventDefault(), commit()) },
      input,
      suggest,
      h('button', { class: 'icon-btn small ok', type: 'submit', title: 'Save name', 'aria-label': 'Save name' }, icon('check', 14)),
      h('button', { class: 'icon-btn small', type: 'button', title: 'Cancel', 'aria-label': 'Cancel renaming', onClick: stop }, icon('x', 14)),
    );
  }

  function tabList(session) {
    return h('ul', { class: 'session-tabs' },
      session.tabs.slice(0, 300).map((t) => {
        const group = t.g >= 0 ? session.groups[t.g] : null;
        return h('li', { class: 'tab-item', title: t.url },
          group ? h('span', { class: 'swatch', style: { background: COLOR_VAR(group.color) }, title: group.title || 'Unnamed group' }) : h('span', { class: 'swatch', style: { background: 'transparent' } }),
          h('img', { class: 'fav', alt: '', src: t.favIcon || null, referrerpolicy: 'no-referrer', onError: (e) => e.target.removeAttribute('src') }),
          h('span', { class: 'tab-title' }, t.title || t.url),
        );
      }),
      session.tabs.length > 300 ? h('li', { class: 'tab-item' }, h('span', { class: 'tab-title' }, `…and ${session.tabs.length - 300} more`)) : null,
    );
  }

  function armDelete(id) {
    state.confirmId = id;
    clearTimeout(state.confirmTimer);
    state.confirmTimer = setTimeout(() => {
      state.confirmId = null;
      renderList();
    }, 3000);
    renderList();
  }

  async function remove(session) {
    clearTimeout(state.confirmTimer);
    state.confirmId = null;
    state.expanded.delete(session.id);
    await removeSession(session.id);
    setStatus({ text: `Deleted “${session.name}”` });
    renderList();
  }

  async function stopSyncing(session) {
    await unlinkSession(session.id);
    setStatus({ text: `Stopped syncing “${session.name}”`, sub: 'Its window stays open, but changes there are no longer saved to the session.' });
    renderList();
  }

  async function openIt(session, target) {
    if (state.busy) return;
    setBusy(true);
    try {
      const win = await chrome.windows.getCurrent();
      const info = await openTracked(session, { target, windowId: win.id });
      if (info.switched) return setStatus({ text: `Switched to “${session.name}”`, sub: 'It was already open in another window.' });
      if (info.createdIds.length === 0) return setStatus({ error: 'None of the tabs in this session could be opened.' });
      const failed = info.failed.length ? `${info.failed.length} tab${info.failed.length === 1 ? '' : 's'} could not be opened.` : null;
      setStatus({
        text: `Opened “${session.name}”`,
        sub: [
          target === 'new' ? 'In a new window.' : 'In this window.',
          info.tracking ? 'Changes there are saved to the session automatically.' : null,
          failed,
        ].filter(Boolean).join(' '),
        undo: () => undoTrackedOpen(info),
      });
    } catch (err) {
      setStatus({ error: err?.message ?? 'Could not open the session.' });
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function refresh() {
    await Promise.all([renderList(), refreshSaveBox()]);
  }

  return { refresh, renderList, refreshSaveBox };
}
