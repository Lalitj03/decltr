// Opening many tabs without loading them all at once.
//
// Opening 650 tabs the plain way starts 650 pages loading together, which can use more memory than the
// computer has and crash the browser. Chrome has no way to create a tab that starts unloaded, and unloading
// (discarding) a tab before its page has started erases its address. So each tab is created, allowed to load
// until Chrome knows its address and title, and then unloaded. Only a few tabs load at the same time, so
// memory stays about the same however many tabs are opened. An unloaded tab loads again when it is clicked.
//
// Unloading gives a tab a new ID in Chrome, so callers must use the IDs this returns, not the ones from creating.

const attempt = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** From this many tabs on, tabs open unloaded. Fewer than this simply load, as they always did. */
export const LIGHT_OPEN_FROM = 16;
/** How many tabs may be loading at the same time while opening lightly. */
export const LOADING_AT_ONCE = 6;

/**
 * True when a tab's title is only its address, which is what Chrome shows until a page sends its title,
 * and what an unloaded tab keeps showing if it was unloaded before that.
 */
export function weakTitle(title, url) {
  if (!title) return true;
  const t = String(title).trim().replace(/\/+$/, '');
  const u = String(url ?? '').trim().replace(/\/+$/, '');
  return t === u || t === u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

/** Chrome knows the page's address (the navigation has started), so unloading will keep it. */
const committed = (tab) => Boolean(tab.url) && tab.url !== 'about:blank' && !tab.pendingUrl;

/**
 * Wait until a new tab has its address and, if it comes in time, its title, then unload it.
 * Returns the tab's ID after unloading, or null if the tab is gone.
 */
async function settle(tabId, { titleWaitMs, commitWaitMs, pollMs }) {
  const started = Date.now();
  for (;;) {
    const tab = await attempt(() => chrome.tabs.get(tabId));
    if (!tab) return { id: null, unloaded: false };
    const waited = Date.now() - started;
    if (committed(tab)) {
      const titled = tab.status === 'complete' || !weakTitle(tab.title, tab.url);
      if (titled || waited >= titleWaitMs) break;
    } else if (waited >= commitWaitMs) {
      // Never got going. Unloading now would erase the address, so leave it loading.
      return { id: tabId, unloaded: false };
    }
    await sleep(pollMs);
  }
  const replaced = await attempt(() => chrome.tabs.discard(tabId));
  return replaced ? { id: replaced.id, unloaded: true } : { id: tabId, unloaded: false };
}

/**
 * Open tabs in order. `specs` are { url, pinned?, index? }. Returns { ids, failed, stopped, unloaded }:
 * ids[i] is the final ID of specs[i], or null if it could not be opened or was not reached.
 *
 * With `light` (the default from LIGHT_OPEN_FROM tabs on), tabs are unloaded once their address and title are
 * known, except pinned tabs (they only show an icon, so they stay loaded) and those `keepLoaded(i)` names.
 * Tabs are created one after another, so they keep their order and their `index`, while up to
 * LOADING_AT_ONCE of them load at the same time. `signal` stops before the next tab; tabs already
 * created are kept. `onCreated(i, id)` runs as each tab appears, before the next one is created.
 */
export async function openTabsLightly(specs, {
  windowId,
  light = specs.length >= LIGHT_OPEN_FROM,
  keepLoaded = () => false,
  concurrency = LOADING_AT_ONCE,
  titleWaitMs = 2000, // a page slower than this shows its address as its title until clicked; the session keeps the real one
  commitWaitMs = 10_000,
  pollMs = 100,
  onCreated,
  onProgress,
  signal,
} = {}) {
  const ids = new Array(specs.length).fill(null);
  const failed = [];
  const settling = [];
  let loading = 0;
  const waiting = [];
  const takeSlot = () => (loading < concurrency ? (loading++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const freeSlot = () => {
    const next = waiting.shift();
    if (next) next();
    else loading--;
  };
  let done = 0;
  let unloaded = 0;
  const progress = () => onProgress?.({ done, total: specs.length });
  let stopped = false;

  for (let i = 0; i < specs.length; i++) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const spec = specs[i];
    const unload = light && !spec.pinned && !keepLoaded(i);
    if (unload) await takeSlot();
    if (signal?.aborted) {
      if (unload) freeSlot();
      stopped = true;
      break;
    }
    const tab = await attempt(() =>
      chrome.tabs.create({ windowId, url: spec.url, active: false, pinned: Boolean(spec.pinned), ...(Number.isInteger(spec.index) ? { index: spec.index } : {}) }),
    );
    if (!tab) {
      failed.push(i);
      if (unload) freeSlot();
      done++;
      progress();
      continue;
    }
    ids[i] = tab.id;
    await onCreated?.(i, tab.id);
    if (!unload) {
      done++;
      progress();
      continue;
    }
    settling.push(
      settle(tab.id, { titleWaitMs, commitWaitMs, pollMs })
        .then((r) => {
          ids[i] = r.id;
          if (r.unloaded) unloaded++;
        })
        .finally(() => {
          freeSlot();
          done++;
          progress();
        }),
    );
  }
  await Promise.all(settling);
  return { ids, failed, stopped, unloaded };
}
