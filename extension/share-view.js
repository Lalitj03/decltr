// What sharing looks like in the panel: the "Share sessions between browsers" box in Settings, the chip and
// any questions on the Sessions tab, and syncing every few seconds while the panel is open.
// The syncing itself is lib/share.js.
import { h, icon } from './ui.js';
import { checkHealth, controlServer } from './lib/api.js';
import { ago } from './lib/archive.js';
import { loadSessions } from './lib/sessions.js';
import {
  forgetBrowser, getShare, liveElsewhere, renameThisBrowser, resolvePending, savedIn, SHARE_KEY, syncNow, turnOffSharing, turnOnSharing,
} from './lib/share.js';

const POLL_MS = 5000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seen = (ms) => (Date.now() - ms < 2 * 60 * 1000 ? 'active now' : ago(ms));
/** "Edge" for "Microsoft Edge", where space is short. */
const short = (name) => name.replace(/^(Google|Microsoft)\s+/, '');

/**
 * `els`: { box, chip, alerts }. `sessionsView` gets the decorations (which browser a session came from, which
 * sessions are live elsewhere). `isVisible()` says whether the panel shows something worth keeping fresh.
 */
export function createShareView({ els, sessionsView, isVisible, openSettings }) {
  const st = { share: null, server: 'checking', folder: '', confirm: false, renaming: false, busy: false, note: '' };

  async function refresh() {
    st.share = await getShare();
    render();
  }

  async function checkServer() {
    try {
      const info = await checkHealth();
      st.server = info.features?.includes('sessions') ? 'ok' : 'old';
      st.managed = Boolean(info.managed);
      st.folder = info.sharing?.folder ?? '';
    } catch {
      st.server = 'none';
    }
    render();
  }

  async function sync(reason) {
    if (!st.share?.on) return;
    await syncNow({ reason, ifIdle: true }).catch(() => {});
  }

  // Keep it fresh while the panel is open, and react to syncs made by the background or another window's panel.
  setInterval(() => {
    if (st.share?.on && !document.hidden && isVisible()) sync('poll');
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => !document.hidden && sync('visible'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SHARE_KEY]) refresh();
  });

  /* ---------------------------------------------------------------- actions */

  async function run(fn) {
    st.busy = true;
    render();
    try {
      await fn();
    } finally {
      st.busy = false;
      await refresh();
    }
  }

  const turnOn = () => run(async () => {
    st.confirm = false;
    st.note = '';
    await turnOnSharing();
  });
  const turnOff = () => run(async () => {
    await turnOffSharing();
    st.note = 'Sharing is off. Every session is still here.';
  });

  async function askToTurnOn() {
    if (st.server !== 'ok') return;
    st.count = (await loadSessions()).length;
    st.confirm = true;
    render();
  }

  async function restart() {
    st.busy = true;
    st.note = 'Restarting the Decltr server…';
    render();
    try {
      await controlServer('restart');
      for (let i = 0; i < 30 && st.server !== 'ok'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        await checkServer();
      }
      st.note = st.server === 'ok' ? '' : 'It did not come back. Check the log: npm run server:logs';
    } catch (err) {
      st.note = err?.message ?? 'That did not work.';
    } finally {
      st.busy = false;
      render();
    }
  }

  /* ----------------------------------------------------------------- render */

  function render() {
    const share = st.share;
    if (!share) return;
    renderBox(share);
    renderChip(share);
    renderAlerts(share);
    sessionsView.setSharing({
      on: share.on,
      peers: share.on ? share.peers.map((p) => p.name) : [],
      fromName: (s) => savedIn(share, s),
      liveElsewhere: (id) => liveElsewhere(share, id),
    });
  }

  function statusOf(share) {
    if (!share.on) return { text: 'Advanced' };
    if (st.busy) return { text: 'Syncing…' };
    const s = share.status;
    if (!s) return { text: 'Starting…' };
    if (s.ok) return { text: 'Up to date', ok: true };
    if (s.code === 'offline') return { text: 'Paused', paused: true };
    if (s.code === 'outdated') return { text: 'Needs an update', problem: true };
    return { text: 'Problem', problem: true };
  }

  function renderBox(share) {
    const status = statusOf(share);
    const head = h('div', { class: 'server-head' }, h('strong', null, 'Share sessions between browsers'), h('span', { class: 'server-state' }, status.text));
    const parts = [head];

    if (!share.on) {
      if (st.server === 'none' || st.server === 'checking') {
        parts.push(h('p', { class: 'server-help' },
          'Chrome, Edge, Brave and other browsers on this computer can see the same sessions, through the optional Decltr server. ',
          st.server === 'checking' ? 'Checking whether it is running…' : 'It is not running here. Set it up with npm run server:install, as the README describes.'));
      } else if (st.server === 'old') {
        parts.push(h('p', { class: 'server-help' }, 'The Decltr server on this computer is too old to share sessions. Restart it to update it.'));
        parts.push(st.managed
          ? h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', disabled: st.busy, onClick: restart }, 'Restart the server'))
          : h('p', { class: 'server-help' }, h('code', null, 'npm run server:restart')));
      } else {
        parts.push(switchRow(false, 'Chrome, Edge, Brave and other browsers with Decltr see the same sessions, through the Decltr server. Sessions stay on this computer.'));
        if (st.confirm) {
          parts.push(h('div', { class: 'ai-consent', role: 'alertdialog', 'aria-label': 'Start sharing sessions' },
            h('strong', null, `Share your ${plural(st.count ?? 0, 'session')}?`),
            h('p', null, 'They will appear in every browser on this computer that shares sessions, and sessions from those browsers will appear here. Nothing is deleted.'),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', type: 'button', disabled: st.busy, onClick: turnOn }, 'Share'),
              h('button', { class: 'btn small ghost', type: 'button', onClick: () => sessionsView.openExport() }, 'Export a backup first'),
              h('button', { class: 'btn small ghost', type: 'button', onClick: () => ((st.confirm = false), render()) }, 'Cancel')),
          ));
        }
      }
      if (st.note) parts.push(h('p', { class: 'server-help' }, st.note));
      els.box.replaceChildren(...parts);
      return;
    }

    parts.push(switchRow(true, 'Through the Decltr server. Sessions stay on this computer.'));
    parts.push(st.renaming ? renameRow(share) : h('div', { class: 'me-row' },
      'This browser is called ', h('b', null, share.me.name),
      h('button', { class: 'icon-btn small', type: 'button', title: 'Rename this browser', 'aria-label': 'Rename this browser', onClick: () => ((st.renaming = true), render()) }, icon('pencil', 13))));
    parts.push(share.peers.length
      ? h('ul', { class: 'browsers' }, share.peers.map((p) => h('li', null,
        icon('share', 14), h('span', { class: 'name' }, p.name), h('small', null, seen(p.lastSeen)),
        h('button', { class: 'link-btn', type: 'button', title: 'Take this browser off the list. It comes back if it shares again.', onClick: () => run(() => forgetBrowser(p.id)) }, 'Remove'))))
      : h('p', { class: 'server-help' }, 'No other browser shares yet. Turn this on in Decltr in another browser on this computer.'));
    const s = share.status;
    if (status.ok) parts.push(h('div', { class: 'ok-line' }, icon('check', 14), `${plural(share.count ?? 0, 'session')} shared · up to date`));
    else if (status.paused) parts.push(h('p', { class: 'server-help' }, 'Paused. The Decltr server is not running. Everything keeps working here, and changes are shared when it is back. Start it with ', h('code', null, 'npm run server:start')));
    else if (s && !s.ok) parts.push(h('p', { class: 'server-help bad' }, s.message));
    if (share.problem) parts.push(h('p', { class: 'server-help bad' }, share.problem));
    if (st.folder) parts.push(h('p', { class: 'fine-line' }, `Kept in ${st.folder}`));
    els.box.replaceChildren(...parts);
  }

  function switchRow(checked, text) {
    const input = h('input', { type: 'checkbox', checked, disabled: st.busy, 'aria-label': 'Share with other browsers on this computer' });
    input.addEventListener('change', () => {
      if (input.checked) {
        input.checked = false; // stays off until you confirm
        askToTurnOn();
      } else {
        turnOff();
      }
    });
    return h('label', { class: 'switch-row' }, input, h('span', { class: 'switch', 'aria-hidden': 'true' }),
      h('span', null, h('strong', null, 'Share with other browsers on this computer'), h('small', null, text)));
  }

  function renameRow(share) {
    const input = h('input', { type: 'text', maxlength: '40', value: share.me.name, 'aria-label': 'Name of this browser' });
    const done = () => ((st.renaming = false), render());
    const save = () => run(async () => {
      st.renaming = false;
      await renameThisBrowser(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') done();
    });
    setTimeout(() => input.select(), 0);
    return h('div', { class: 'me-row rename' }, input,
      h('button', { class: 'icon-btn small ok', type: 'button', title: 'Save', 'aria-label': 'Save name', onClick: save }, icon('check', 14)),
      h('button', { class: 'icon-btn small', type: 'button', title: 'Cancel', 'aria-label': 'Cancel renaming', onClick: done }, icon('x', 14)));
  }

  function renderChip(share) {
    if (!share.on) {
      els.chip.hidden = true;
      return;
    }
    const status = statusOf(share);
    const names = share.peers.map((p) => p.name);
    const text = status.paused ? 'Sharing paused'
      : status.problem ? 'Sharing problem'
        : names.length === 0 ? 'Sharing on'
          : names.length === 1 ? `Shared with ${short(names[0])}` : `Shared with ${names.length} browsers`;
    els.chip.dataset.state = status.paused ? 'paused' : status.problem ? 'problem' : 'ok';
    els.chip.title = [names.length ? `Shared with ${names.join(', ')}` : 'No other browser shares yet', share.status?.at ? `Last synced ${ago(share.status.at)}` : ''].filter(Boolean).join('. ');
    els.chip.replaceChildren(h('span', { class: 'dot' }), h('span', null, text));
    els.chip.hidden = false;
    els.chip.onclick = () => openSettings(els.box);
  }

  function renderAlerts(share) {
    const p = share.on ? share.pending : null;
    if (!p) {
      els.alerts.replaceChildren();
      return;
    }
    const n = p.ids.length;
    const who = p.by?.length ? p.by.join(' and ') : 'Another browser';
    const card = p.kind === 'incoming'
      ? h('div', { class: 'banner', role: 'alert' },
        h('h3', null, icon('alert', 16), `${who} removed ${plural(n, 'session')}. Remove them here too?`),
        h('p', null, 'They are still here. Restoring them shares them again with every browser.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', disabled: st.busy, onClick: () => run(() => resolvePending('remove')) }, 'Remove here too'),
          h('button', { class: 'btn primary', type: 'button', disabled: st.busy, onClick: () => run(() => resolvePending('restore')) }, 'Restore them')))
      : h('div', { class: 'banner', role: 'alert' },
        h('h3', null, icon('alert', 16), `${plural(n, 'session')} ${n === 1 ? 'is' : 'are'} missing in this browser. Remove ${n === 1 ? 'it' : 'them'} from the other browsers too?`),
        h('p', null, `${n === 1 ? 'It was' : 'They were'} not deleted in Decltr, so ${n === 1 ? 'it' : 'they'} may have been lost by accident. Bringing ${n === 1 ? 'it' : 'them'} back copies ${n === 1 ? 'it' : 'them'} from the shared sessions.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', disabled: st.busy, onClick: () => run(() => resolvePending('restore')) }, 'Bring them back'),
          h('button', { class: 'btn', type: 'button', disabled: st.busy, onClick: () => run(() => resolvePending('remove')) }, 'Remove everywhere')));
    els.alerts.replaceChildren(card);
  }

  return {
    async init() {
      await refresh();
      await checkServer();
      if (st.share.on) sync('open');
    },
    /** When the Sessions tab or Settings is shown. */
    shown() {
      if (st.share?.on) sync('shown');
      checkServer();
    },
  };
}
