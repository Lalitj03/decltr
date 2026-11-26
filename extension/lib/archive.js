// "Archive old tabs": tabs you have not used for a while are saved as a session and closed, on this device.
//
// Chrome (121 and later) records when each tab was last shown. A browser restart can reset that time for
// some tabs, which only ever makes them look more recent, so archiving errs on the side of keeping tabs.

import { saveableTabs } from './sessions.js';

export const DAY = 24 * 60 * 60 * 1000;

export const ARCHIVE_AGES = [
  { days: 7, label: '1 week', phrase: 'a week' },
  { days: 14, label: '2 weeks', phrase: '2 weeks' },
  { days: 30, label: '1 month', phrase: 'a month' },
  { days: 90, label: '3 months', phrase: '3 months' },
  { days: 180, label: '6 months', phrase: '6 months' },
];

const known = (t) => Number.isFinite(t.lastAccessed) && t.lastAccessed > 0;

/** False in browsers that do not say when tabs were last used. */
export const knowsLastUse = (tabs) => tabs.some(known);

/**
 * Tabs not used for at least `days`, least recently used first. Never the tab you are on, a tab playing
 * sound, or a page that cannot be saved. Pinned tabs only come in when the caller passes them in.
 */
export function staleTabs(tabs, { days, now = Date.now() }) {
  const cutoff = now - days * DAY;
  return saveableTabs(tabs)
    .filter((t) => !t.active && !t.audible && known(t) && t.lastAccessed <= cutoff)
    .sort((a, b) => a.lastAccessed - b.lastAccessed);
}

/** Each age with how many tabs it would archive right now. */
export const countByAge = (tabs, now = Date.now()) => ARCHIVE_AGES.map((age) => ({ ...age, count: staleTabs(tabs, { days: age.days, now }).length }));

/** "Not used since 12 Nov": the name of the session an archive is saved as. */
export function archiveName(days, now = Date.now()) {
  const since = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(now - days * DAY));
  return `Not used since ${since}`;
}

/** A plan with one "archive" action: save the stale tabs as a session, then close them. */
export function planArchive(tabs, { days, now = Date.now() }) {
  const age = ARCHIVE_AGES.find((a) => a.days === days) ?? { phrase: `${days} days` };
  if (!knowsLastUse(tabs)) {
    return { summary: '', message: 'This browser does not say when tabs were last used, so Decltr cannot tell which ones are old. Chrome 121 or later is needed.', actions: [] };
  }
  const stale = staleTabs(tabs, { days, now });
  if (stale.length === 0) return { summary: '', message: `Every tab here has been used in the last ${age.phrase}. Nothing to archive.`, actions: [] };
  const n = stale.length;
  return {
    summary: `Save the ${n} tab${n === 1 ? '' : 's'} you have not used for ${age.phrase} as a session, then close ${n === 1 ? 'it' : 'them'}. Reopen ${n === 1 ? 'it' : 'them'} any time from Sessions.`,
    message: '',
    actions: [{ type: 'archive', name: archiveName(days, now), tabIds: stale.map((t) => t.id), reason: `Not used for ${age.phrase} or more` }],
  };
}

/** "3 weeks ago". Rounded down, so a tab is never shown as older than it is. */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  const units = [[365 * 86400, 'year'], [30 * 86400, 'month'], [7 * 86400, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}
