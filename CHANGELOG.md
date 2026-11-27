# Changelog

## 0.8.1 (unreleased): nothing leaves your computer with local AI

- Tab icons now come from the browser's own icon store. Before, the panel loaded each tab's icon from its site, so showing a session or a plan contacted those sites. Checked in Chrome and Edge: the panel makes no request about the tabs it shows. New permission `favicon`, with no new install warning (the `tabs` warning already covers it).
- Ollama's cloud models (names ending in `cloud`, such as `gemma4:cloud`) run on ollama.com, so Decltr now asks before using one, like any online service, and says "Sends tab titles to ollama.com". Models on your computer still never ask.
- New store text, short description and graphics that lead with what Decltr is: independent and open source, it runs on your device and collects no data. Brand guide in `store/BRAND.md`.

## 0.8.0 (unreleased): share sessions between browsers (server 0.4.0)

- Advanced: Chrome, Edge, Brave and other Chromium browsers on this computer can see the same sessions, through the optional Decltr server. Changes go across by themselves. A deletion wins; typed names beat AI names; name and tabs merge separately.
- One browser at a time keeps a session live; "Sync here instead" moves it.
- Safety nets: nothing is deleted when sharing starts, mass removals wait for you, the server keeps daily copies for 7 days, and turning sharing off keeps every session.
- When the server is stopped, each browser keeps working with its own copy and catches up when it is back.
- Server: `/v1/sessions/sync`, a shared folder only you can read, `DECLTR_DATA_DIR`, and sharing in `npm run server:status`.
- New permission `alarms` (no install warning), for syncing every few minutes.

## 0.7.0 (unreleased): export and import

- Export sessions to a file, or copy them as Markdown links. Import Decltr files, OneTab exports, Markdown links, bookmarks files or any list of links, with a preview, "Already here" for sessions you have, and Undo.
- Drop a file on the Sessions tab to import it.
- Find a session by name, group, tab title or address, from 10 sessions.
- Up to 1000 sessions, and the newest are always the ones listed (before, the list could skip sessions beyond 200).
- `npm run package` builds a store zip and an unpacked zip that keeps the pinned extension ID, for GitHub releases.
- New permission `unlimitedStorage` (no install warning), so big sessions never hit the browser's 10 MB limit.

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
