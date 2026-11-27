import { h, icon, progressView } from './ui.js';
import { createTransferView } from './transfer-view.js';
import { matchesQuery } from './lib/session-format.js';
import { snapshot } from './lib/tabs.js';
import { nameWithAI } from './lib/ai/index.js';
import { undoPlan } from './lib/actions.js';
import {
  buildSession, defaultSessionName, describeSession, knowsLastUse, loadSessions, pickByLastUse, renameSession, saveableTabs, saveSession,
} from './lib/sessions.js';
import { ago } from './lib/archive.js';
import { LIGHT_OPEN_FROM } from './lib/light-open.js';
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
  // picked: sessionId -> Set of tab positions chosen in the picker ("open part of a session").
  const state = {
    busy: false, nameEdited: false, confirmId: null, confirmTimer: null, expanded: new Set(), editingId: null, lastSig: '', deferred: false,
    picked: new Map(), stop: null, query: '', fresh: new Set(), freshTimer: null,
  };
  const searchCache = new Map();
  /** Decorations from sharing (share-view.js): which browser made a session, and which sessions are live elsewhere. */
  let sharing = { on: false, peers: [], fromName: () => null, liveElsewhere: () => null, takeOver: null };

  const transfer = createTransferView({
    els: { tool: els.tool, status: els.status, importFile: els.importFile },
    setStatus: (s) => setStatus(s),
    onImported: (ids) => highlight(ids),
    getSharing: () => sharing,
  });
  els.importBtn.append(icon('import', 14), 'Import');
  els.exportBtn.append(icon('export', 14), 'Export');
  els.importBtn.addEventListener('click', () => transfer.pickFile());
  els.exportBtn.addEventListener('click', () => transfer.openExport());
  els.searchIcon.append(icon('search', 15));
  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim();
      renderList({ force: true });
    }, 120);
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.search.value) {
      e.preventDefault();
      els.search.value = '';
      state.query = '';
      renderList({ force: true });
    }
  });

  // Drop a file anywhere on the Sessions tab to import it. A box shows where while a file is dragged over.
  els.dropIcon.append(icon('import', 22));
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  els.view.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    els.drop.hidden = false;
  });
  els.view.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  els.view.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.drop.hidden = true;
  });
  els.view.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.drop.hidden = true;
    const file = e.dataTransfer.files?.[0];
    if (file) transfer.importFile(file);
  });

  /** Mark just-imported sessions for a few seconds, and bring the first into view. */
  function highlight(ids) {
    state.fresh = new Set(ids);
    clearTimeout(state.freshTimer);
    state.freshTimer = setTimeout(() => {
      state.fresh = new Set();
      renderList({ force: true });
    }, 6000);
    renderList({ force: true }).then(() => els.list.querySelector('.session.fresh')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

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
    els.exportBtn.disabled = sessions.length === 0;

    // A search box once the list is long enough to need one.
    els.searchRow.hidden = sessions.length < 10 && !state.query;
    const shown = state.query ? sessions.filter((s) => matchesQuery(s, state.query, searchCache)) : sessions;
    els.searchCount.textContent = state.query ? `${shown.length} of ${sessions.length}` : '';
    els.noMatches.hidden = !(state.query && sessions.length && shown.length === 0);
    els.noMatches.textContent = state.query ? `No session matches “${state.query}”. Search looks at names, tab titles and addresses.` : '';

    // Live sessions change often; skip the rebuild when nothing visible changed.
    const decor = shown.map((s) => [s.id, s.name, s.updatedAt, s.tabs.length, live.has(s.id), sharing.fromName(s), sharing.liveElsewhere(s.id)?.name ?? '']);
    const sig = JSON.stringify([decor, [...state.expanded], state.confirmId, state.busy, state.query, [...state.fresh], sharing.on]);
    if (sig === state.lastSig && !force) return;
    state.lastSig = sig;
    state.deferred = false;
    els.list.replaceChildren(...shown.map((s) => sessionCard(s, live.has(s.id))));
  }

  /** Called by the sharing view whenever what it knows changes. */
  function setSharing(next) {
    sharing = { ...sharing, ...next };
    renderList();
  }

  function sessionCard(session, isLive) {
    const expanded = state.expanded.has(session.id);
    const confirming = state.confirmId === session.id;
    const shown = session.tabs.slice(0, 8);

    return h('li', { class: `session${state.fresh.has(session.id) ? ' fresh' : ''}`, 'data-id': session.id },
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
          class: 'icon-btn expand', type: 'button', 'aria-expanded': String(expanded), 'aria-label': `Show tabs in ${session.name}, or open some of them`, title: 'Show tabs, or open some of them',
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
      session.kind === 'archive' ? h('span', { class: 'tag', title: 'Made by Archive old tabs' }, icon('clock', 12), 'Archive') : null,
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

  /**
   * The expanded session: every tab, sorted under its group, each with a checkbox. Picking some shows
   * buttons to open just those. A quick pick selects the most or least recently used tabs.
   * The list updates itself on clicks, so picking never rebuilds the session list.
   */
  function tabList(session) {
    const picked = state.picked.get(session.id) ?? new Set();
    state.picked.set(session.id, picked);
    const total = session.tabs.length;
    const sections = [];
    session.groups.forEach((g, gi) => sections.push({ g: gi, title: g.title || 'Unnamed group', color: g.color, positions: [] }));
    const loose = { g: -1, title: 'Not in a group', color: null, positions: [] };
    session.tabs.forEach((t, i) => (t.g >= 0 ? sections[t.g] : loose).positions.push(i));
    if (loose.positions.length) sections.push(loose);

    const boxes = new Map(); // position -> checkbox
    const heads = []; // [checkbox, section]
    const count = h('b', null, '');
    const foot = h('div', { class: 'picker-foot', hidden: true },
      count,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => openIt(session, 'new', [...picked]) }, icon('newWindow', 15), 'New window'),
        h('button', { class: 'btn', type: 'button', onClick: () => openIt(session, 'here', [...picked]) }, icon('here', 15), 'This window'),
      ),
      h('small', null, 'A window with part of a session is not kept up to date, so the saved session stays whole.'),
    );
    const sync = () => {
      for (const [i, box] of boxes) box.checked = picked.has(i);
      for (const [box, sec] of heads) {
        const n = sec.positions.filter((i) => picked.has(i)).length;
        box.checked = n > 0 && n === sec.positions.length;
        box.indeterminate = n > 0 && n < sec.positions.length;
      }
      count.textContent = `${picked.size} of ${total} tab${total === 1 ? '' : 's'} picked`;
      foot.hidden = picked.size === 0;
      foot.querySelectorAll('.btn').forEach((b) => (b.disabled = state.busy));
    };
    const toggle = (positions, on) => {
      positions.forEach((i) => (on ? picked.add(i) : picked.delete(i)));
      sync();
    };

    const quick = [['', 'Pick…'], ['all', 'All tabs'], ['none', 'None']];
    if (knowsLastUse(session)) {
      for (const n of [10, 25, 50, 100]) if (n < total) quick.push([`new:${n}`, `${n} most recently used`]);
      for (const n of [10, 25, 50, 100]) if (n < total) quick.push([`old:${n}`, `${n} least recently used`]);
    }
    const select = h('select', { class: 'quick-pick', 'aria-label': 'Pick tabs quickly' }, quick.map(([v, label]) => h('option', { value: v }, label)));
    select.addEventListener('change', () => {
      const [kind, n] = select.value.split(':');
      picked.clear();
      if (kind === 'all') session.tabs.forEach((_, i) => picked.add(i));
      if (kind === 'new' || kind === 'old') pickByLastUse(session, { count: Number(n), newest: kind === 'new' }).forEach((i) => picked.add(i));
      select.value = '';
      sync();
    });

    const list = h('ul', { class: 'session-tabs' },
      sections.map((sec) => {
        const head = h('input', { type: 'checkbox', class: 'check', 'aria-label': `Pick all of ${sec.title}` });
        head.addEventListener('change', () => toggle(sec.positions, head.checked));
        heads.push([head, sec]);
        const showHead = session.groups.length > 0;
        return [
          showHead ? h('li', { class: 'pick-group' },
            head,
            sec.color ? h('span', { class: 'swatch', style: { background: COLOR_VAR(sec.color) } }) : h('span', { class: 'swatch', style: { background: 'transparent', border: '1px dashed var(--line)' } }),
            h('span', { class: 'tab-title' }, sec.title),
            h('span', { class: 'group-count' }, String(sec.positions.length)),
          ) : null,
          sec.positions.map((i) => {
            const t = session.tabs[i];
            const box = h('input', { type: 'checkbox', class: 'check', 'aria-label': `Pick ${t.title || t.url}` });
            box.addEventListener('change', () => toggle([i], box.checked));
            boxes.set(i, box);
            return h('li', { class: `tab-item pick${showHead ? ' indent' : ''}`, title: t.url },
              box,
              h('img', { class: 'fav', alt: '', src: t.favIcon || null, referrerpolicy: 'no-referrer', onError: (e) => e.target.removeAttribute('src') }),
              h('span', { class: 'tab-title', onClick: () => toggle([i], !picked.has(i)) }, t.title || t.url),
              t.used ? h('span', { class: 'tab-when' }, ago(t.used)) : null,
            );
          }),
        ];
      }),
    );
    const node = h('div', { class: 'picker' },
      h('div', { class: 'picker-bar' },
        h('span', null, 'Open only some tabs?'),
        h('span', { class: 'row' }, select,
          h('button', { class: 'icon-btn small', type: 'button', title: 'Export this session to a file', 'aria-label': `Export ${session.name}`, onClick: () => transfer.openExport(session.id) }, icon('export', 14)))),
      list,
      foot,
    );
    sync();
    return node;
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

  async function openIt(session, target, positions) {
    if (state.busy) return;
    setBusy(true);
    const n = positions ? positions.length : session.tabs.length;
    const stop = new AbortController();
    let progress = null;
    if (n >= LIGHT_OPEN_FROM) {
      // Big sessions open without loading every tab, a few at a time, so show how far it is.
      progress = progressView({ title: `Opening ${n} tabs`, detail: 'They load when you click them.', iconName: 'newWindow', onStop: () => stop.abort() });
      els.status.replaceChildren(progress.node);
    }
    try {
      const win = await chrome.windows.getCurrent();
      const info = await openTracked(session, {
        target, windowId: win.id, positions, signal: stop.signal,
        onProgress: (p) => progress?.set({ detail: `${p.done} of ${p.total} opened. They load when you click them.`, done: p.done, total: p.total }),
      });
      if (info.switched) return setStatus({ text: `Switched to “${session.name}”`, sub: 'It was already open in another window.' });
      if (info.createdIds.length === 0) return setStatus({ error: info.stopped ? 'Stopped before any tab was opened.' : 'None of the tabs in this session could be opened.' });
      const failed = info.failed.length ? `${info.failed.length} tab${info.failed.length === 1 ? '' : 's'} could not be opened.` : null;
      const opened = info.createdIds.length;
      setStatus({
        text: info.stopped ? `Stopped after ${opened} of ${n} tabs` : info.partial ? `Opened ${opened} of ${session.tabs.length} tabs from “${session.name}”` : `Opened “${session.name}”`,
        sub: [
          target === 'new' ? 'In a new window.' : 'In this window.',
          info.unloaded ? 'Tabs load when you click them, to save memory.' : null,
          info.tracking ? 'Changes there are saved to the session automatically.' : null,
          info.partial || info.stopped ? 'That window is not kept in sync, so the saved session stays whole.' : null,
          failed,
        ].filter(Boolean).join(' '),
        undo: () => undoTrackedOpen(info),
      });
      if (positions) state.picked.delete(session.id);
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

  return { refresh, renderList, refreshSaveBox, setSharing, openExport: (id) => transfer.openExport(id), setStatus: (st) => setStatus(st) };
}
