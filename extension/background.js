import { createTracker } from './lib/tracker.js';
import { registerShareTriggers } from './lib/share.js';

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Keep opened sessions up to date. Listeners must be registered synchronously at the top
// level so Chrome can wake this worker for the events.
createTracker().register();
// Share sessions with the other browsers on this computer, when that is turned on (share.js).
registerShareTriggers();
