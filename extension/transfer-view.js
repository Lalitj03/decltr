// Export and import in the Sessions tab: cards that work like plans, so nothing happens until you confirm,
// and importing can be undone.
import { h, icon } from './ui.js';
import {
  contentKey, exportFile, exportFileName, parseImport, SESSION_LIMITS, sessionsToMarkdown,
} from './lib/session-format.js';
import { addSessions, describeSession, loadSessions, removeSessions } from './lib/sessions.js';
import { appName, detectBrowserName } from './lib/browser.js';

const dateOnly = (ms) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(new Date(ms));
const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
/** About how big a session is in a file, without building the file. */
const roughSize = (s) => 200 + s.tabs.reduce((n, t) => n + t.url.length + t.title.length + 60, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * `els`: { tool, status, importFile }. `setStatus` shows a result in the Sessions tab, `onImported(ids)` lets the
 * list highlight the new sessions, and `getSharing()` returns { on, peers: [names] } so the preview can say where
 * else the sessions will appear.
 */
export function createTransferView({ els, setStatus, onImported, getSharing = () => ({ on: false, peers: [] }) }) {
  const close = () => els.tool.replaceChildren();
  const show = (card) => {
    els.tool.replaceChildren(card);
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  /* ---------------------------------------------------------------- export */

  /** The export card. `only` ticks just that session; otherwise every session is ticked. */
  async function openExport(only) {
    const sessions = await loadSessions();
    if (sessions.length === 0) return setStatus({ error: 'There are no saved sessions to export yet.' });
    const picked = new Set(only ? [only] : sessions.map((s) => s.id));
    const sub = h('p', null, '');
    const boxes = new Map();
    const save = h('button', { class: 'btn primary', type: 'button' }, icon('export', 16), 'Save file');
    const copy = h('button', { class: 'btn', type: 'button' }, icon('copy', 15), 'Copy as links');
    const chosen = () => sessions.filter((s) => picked.has(s.id));
    const sync = () => {
      const list = chosen();
      const tabs = list.reduce((n, s) => n + s.tabs.length, 0);
      sub.textContent = `${list.length} of ${plural(sessions.length, 'session')} · ${plural(tabs, 'tab')} · about ${sizeText(list.reduce((n, s) => n + roughSize(s), 0))}`;
      for (const [id, box] of boxes) box.checked = picked.has(id);
      save.disabled = copy.disabled = list.length === 0;
    };
    const setAll = (on) => {
      sessions.forEach((s) => (on ? picked.add(s.id) : picked.delete(s.id)));
      sync();
    };
    const list = h('ul', { class: 'pick-list' }, sessions.map((s) => {
      const box = h('input', { type: 'checkbox', class: 'check', 'aria-label': `Export ${s.name}` });
      box.addEventListener('change', () => {
        if (box.checked) picked.add(s.id);
        else picked.delete(s.id);
        sync();
      });
      boxes.set(s.id, box);
      return h('li', { class: 'pick-row' },
        box,
        h('div', { class: 'main', onClick: () => box.click() },
          h('b', null, s.name, s.kind === 'archive' ? h('span', { class: 'tag' }, icon('clock', 12), 'Archive') : null),
          h('small', null, `${describeSession(s)} · ${dateOnly(s.createdAt)}`)),
      );
    }));
    save.addEventListener('click', () => {
      const list_ = chosen();
      const name = exportFileName(list_);
      const text = JSON.stringify(exportFile(list_, { app: appName(), browser: detectBrowserName() }), null, 2);
      download(name, text);
      close();
      setStatus({ text: `Saved “${name}”`, sub: `${plural(list_.length, 'session')}. Look in your downloads, unless your browser asked where to save it.` });
    });
    copy.addEventListener('click', async () => {
      const list_ = chosen();
      try {
        await navigator.clipboard.writeText(sessionsToMarkdown(list_));
        close();
        setStatus({ text: `Copied ${plural(list_.length, 'session')} as links`, sub: 'Paste them into notes or a chat. Importing that text brings them back.' });
      } catch {
        setStatus({ error: 'The browser did not allow copying. Try Save file instead.' });
      }
    });
    const card = h('section', { class: 'card tool-card', 'aria-label': 'Export sessions' },
      h('div', { class: 'card-head' },
        h('div', { class: 'title' }, icon('export', 16), only ? 'Export this session' : 'Export sessions'),
        sub,
      ),
      sessions.length > 1
        ? h('div', { class: 'pick-bar' }, h('span', null, 'Sessions to export'),
          h('span', { class: 'row' },
            h('button', { class: 'link-btn', type: 'button', onClick: () => setAll(true) }, 'All'),
            h('button', { class: 'link-btn', type: 'button', onClick: () => setAll(false) }, 'None')))
        : null,
      sessions.length > 1 ? list : null,
      h('p', { class: 'fine' }, 'The file holds the full address of every tab, so check it before you send it to someone.'),
      h('div', { class: 'card-foot' }, save, copy, h('button', { class: 'btn ghost', type: 'button', onClick: close }, 'Cancel')),
    );
    sync();
    show(card);
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /* ---------------------------------------------------------------- import */

  function pickFile() {
    els.importFile.value = '';
    els.importFile.click();
  }
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files?.[0];
    if (file) importFile(file);
  });

  /** Read a file and show what importing it would do. Nothing is saved until "Import" is pressed. */
  async function importFile(file) {
    if (file.size > SESSION_LIMITS.fileBytes) {
      return setStatus({ error: `That file is ${sizeText(file.size)}. Decltr imports files of up to ${sizeText(SESSION_LIMITS.fileBytes)}.` });
    }
    let text;
    try {
      text = await file.text();
    } catch {
      return setStatus({ error: 'That file could not be read.' });
    }
    const result = parseImport(text, { fileName: file.name });
    if (!result.ok) return setStatus({ error: result.message });
    const here = new Set((await loadSessions()).map(contentKey));
    preview(file.name, result, here);
  }

  function preview(fileName, result, here) {
    const rows = result.sessions.map((s) => ({ session: s, existing: here.has(contentKey(s)) }));
    const picked = new Set(rows.filter((r) => !r.existing).map((r) => r.session));
    const go = h('button', { class: 'btn primary', type: 'button' }, icon('check', 16), '');
    const problem = h('div', { class: 'warn', role: 'alert', hidden: true });
    const sync = () => {
      go.replaceChildren(icon('check', 16), picked.size ? `Import ${plural(picked.size, 'session')}` : 'Nothing to import');
      go.disabled = picked.size === 0;
    };
    const tabs = result.sessions.reduce((n, s) => n + s.tabs.length, 0);
    const origin = result.kind === 'decltr'
      ? [result.exportedAt ? `exported ${dateOnly(result.exportedAt)}` : null, result.from?.browser ? `from ${result.from.browser}` : null].filter(Boolean).join(' ')
      : 'a list of links';
    const sharing = getSharing();
    const notes = [
      result.skipped ? `${plural(result.skipped, 'tab')} ${result.skipped === 1 ? 'was' : 'were'} left out: browser pages and other addresses Decltr does not open from files.` : null,
      result.duplicates ? `${plural(result.duplicates, 'session')} ${result.duplicates === 1 ? 'appears' : 'appear'} twice in the file and ${result.duplicates === 1 ? 'is' : 'are'} shown once.` : null,
      ...(result.notes ?? []),
    ].filter(Boolean);

    go.addEventListener('click', async () => {
      const list = rows.filter((r) => picked.has(r.session)).map((r) => ({ ...r.session, id: crypto.randomUUID() }));
      go.disabled = true;
      try {
        const ids = await addSessions(list);
        close();
        onImported(ids);
        setStatus({
          text: `Imported ${plural(ids.length, 'session')}`,
          sub: `${plural(list.reduce((n, s) => n + s.tabs.length, 0), 'tab')} from “${fileName}”.`,
          undo: () => removeSessions(ids),
        });
      } catch (err) {
        problem.textContent = err?.message ?? 'The sessions could not be imported.';
        problem.hidden = false;
        sync();
      }
    });

    const card = h('section', { class: 'card tool-card', 'aria-label': 'Import sessions' },
      h('div', { class: 'card-head' },
        h('div', { class: 'title' }, icon('import', 16), h('span', { class: 'name' }, `Import from “${fileName}”`)),
        h('p', null, [plural(result.sessions.length, 'session'), plural(tabs, 'tab'), origin].filter(Boolean).join(' · ')),
      ),
      h('ul', { class: 'pick-list' }, rows.map((r) => {
        const s = r.session;
        const box = h('input', { type: 'checkbox', class: 'check', checked: !r.existing, disabled: r.existing, 'aria-label': `Import ${s.name}` });
        box.addEventListener('change', () => {
          if (box.checked) picked.add(s);
          else picked.delete(s);
          sync();
        });
        return h('li', { class: `pick-row${r.existing ? ' off' : ''}` },
          box,
          h('div', { class: 'main', onClick: () => !r.existing && box.click() },
            h('b', null, s.name, s.kind === 'archive' ? h('span', { class: 'tag' }, icon('clock', 12), 'Archive') : null),
            h('small', null, `${describeSession(s)} · saved ${dateOnly(s.createdAt)}`)),
          r.existing ? h('span', { class: 'pill', title: 'A session with the same tabs and groups is already saved here' }, 'Already here') : null,
        );
      })),
      h('div', { class: 'info' }, icon('archive', 16),
        `Sessions are added. Nothing here is replaced or deleted.${sharing.on && sharing.peers.length ? ` They will also appear in ${sharing.peers.join(' and ')}.` : ''}`),
      notes.length ? h('p', { class: 'fine' }, notes.join(' ')) : null,
      problem,
      h('div', { class: 'card-foot' }, go, h('button', { class: 'btn ghost', type: 'button', onClick: close }, 'Cancel')),
    );
    sync();
    show(card);
  }

  return { openExport, pickFile, importFile, close };
}
