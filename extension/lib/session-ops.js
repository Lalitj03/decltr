// The operations that combine sessions, live syncing and tab actions. Keeping the
// ordering rules here (link after opening, unlink before undoing or clearing) means the
// features cannot trip over each other no matter which screen triggers them.

import { applyPlan } from './actions.js';
import {
  applyAutoName, deleteSession, openSession, partOfSession, undoOpen,
} from './sessions.js';
import { isLiveEnabled, linkWindow, liveWindowFor, unlinkSession, unlinkWindow } from './tracker.js';

const attempt = async (fn, fallback = null) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/**
 * Open a session and, if it now owns its window, keep that window synced.
 * "New window" on a session that is already live just switches to its window, so there are
 * never two windows both writing the same session.
 *
 * `positions` opens only those tabs (see pickByGroups and pickByLastUse). Such a window shows part of
 * the session, so it is never synced: saving it back would drop every tab that was left closed.
 * The same goes for an open that was stopped halfway.
 */
export async function openTracked(session, { target, windowId, positions, signal, onProgress }) {
  const partial = Array.isArray(positions) && new Set(positions).size < session.tabs.length;
  if (target === 'new' && !partial) {
    const live = await liveWindowFor(session.id);
    if (live !== null) {
      await attempt(() => chrome.windows.update(live, { focused: true }));
      return { switched: true, windowId: live, newWindow: false, createdIds: [], failed: [], removedBlank: 0, sessionId: session.id, tracking: true };
    }
  }
  const info = await openSession(partial ? partOfSession(session, positions) : session, { target, windowId, signal, onProgress });
  info.sessionId = session.id;
  info.tracking = false;
  info.partial = partial;
  // The window belongs to the session only if it holds nothing else: a fresh window, or one
  // that was just blank. Adding tabs to a busy window must not turn that window into the session.
  const dedicated = info.newWindow || info.wasBlank;
  if (!partial && !info.stopped && info.createdIds.length > 0 && dedicated && (await isLiveEnabled())) {
    await linkWindow(info.windowId, session.id);
    info.tracking = true;
  }
  return info;
}

/** Undo an open. The link goes first, so closing the tabs can never be written back to the session. */
export async function undoTrackedOpen(info) {
  if (info.switched) return;
  await unlinkWindow(info.windowId);
  await undoOpen(info);
}

/**
 * Close the tabs that were just saved. The window stops following any session first: what is
 * left in it no longer represents that session.
 */
export async function clearSavedTabs({ windowId, tabIds }) {
  await unlinkWindow(windowId);
  return applyPlan({ actions: [{ type: 'close', tabIds }] }, { windowId });
}

export async function removeSession(id) {
  await unlinkSession(id);
  await deleteSession(id);
}

/**
 * Name a freshly saved session with AI without making the user wait. `suggest` returns a
 * name or throws. Failure is silent: the default name simply stays. A name the user typed
 * in the meantime always wins (applyAutoName checks this under the storage lock).
 */
export async function autoNameInBackground(session, suggest) {
  if (session.nameSource !== 'default') return false;
  try {
    const name = await suggest(session.tabs.map((t) => ({ title: t.title, url: t.url, group: t.g >= 0 ? session.groups[t.g]?.title : undefined })));
    return await applyAutoName(session.id, name);
  } catch {
    return false;
  }
}
