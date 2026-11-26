# Changelog

## 0.6.0 (unreleased): big windows

- AI actions work on windows with hundreds of tabs. Windows with more than 80 tabs are planned in parts, and similar groups from different parts are merged. Progress is shown, and Stop cancels.
- On-device actions work on every tab, not only the first 300.
- Big sessions open lightly: tabs appear at once but load when clicked, so opening 650 tabs no longer runs out of memory. Undoing a big close reopens tabs the same way.
- Archive old tabs: save tabs not used for 1 week, 2 weeks, 1 month, 3 months or 6 months as a session, then close them.
- Open part of a session: pick groups, single tabs, or the most or least recently used tabs. Such a window is not kept in sync.
- Suggestions on the start screen for windows with 120 or more tabs.
- Live syncing keeps titles and icons of tabs that are not loaded.
- The start screen separates actions that use AI from those that run on this device, and says where AI actions send tab details.

## 0.5.0 (unreleased): first Chrome Web Store version

- Works without the local server. Choose Google Gemini (your key), Ollama on your computer, or any OpenAI-compatible service in Settings → AI model.
- Ollama works without setting `OLLAMA_ORIGINS`.
- Before tab details go to another computer, Decltr shows what is sent and where, and waits for you to agree.
- Host access and the bookmarks permission are asked for only when needed.
- A fresh install shows the model choices instead of "Server offline".
- `npm run package` builds the store zip.
- MIT licence.

## 0.4.0

- Sessions: save, save and clear, reopen, rename, AI naming, live sync.
- Group manager, ungroup, regroup.
- Optional background server with start, stop and restart from the panel.
