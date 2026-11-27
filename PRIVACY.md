# Decltr privacy policy

Effective 26 November 2026. This policy covers the Decltr browser extension (for Chrome and Microsoft Edge) and the optional Decltr server.

Decltr is an independent, open-source hobby project. It has no server of its own, no accounts, no analytics and no advertising. The developer receives no data from you.

## What Decltr handles, and where it goes

| Data | Where it stays or goes |
| --- | --- |
| **Your open tabs** (titles, addresses, groups) | Read in your browser to show and carry out plans. |
| **Your request** and the **titles and addresses of the tabs involved** | Only when you use an AI action or AI naming, and only to the AI model **you** chose. Everything after `?` or `#` in an address is removed first. |
| **API keys and AI settings** | Stored in this browser profile only (`chrome.storage.local`). Never synced. A key is sent only to the service it belongs to. |
| **Saved sessions, settings, undo information** | Stored in this browser profile only. Never sent anywhere. Sessions include when each tab was last used, which is used for "Archive old tabs" and for opening the most or least recently used tabs. |
| **Exported files** | Saved where your browser saves downloads, only when you press Export. They hold the full address of every tab in the sessions you picked. |
| **Bookmarks** | Created in your own Chrome bookmarks, only when you apply a plan that saves bookmarks. |

Where AI requests go depends on what you choose in Settings → AI model:

- **Google Gemini**: to Google, under the [Gemini API terms](https://ai.google.dev/gemini-api/terms). With a free (unpaid) key, those terms let Google use what it receives to improve its products, and people at Google may read it. A key from a project with billing turned on is not used that way.
- **Another service** (OpenAI-compatible): to the address you entered. That service's own policy applies.
- **Ollama** on your computer, or the optional **Decltr server**: to a program on your own computer. Ollama keeps everything on your computer. The Decltr server forwards requests to Google Gemini with the key you gave it.

Before anything goes to another computer, Decltr shows what it sends and where, and waits for you to agree. Quick actions marked *On-device* never send anything.

## How your API key is stored

Your key is kept in the browser's storage for this extension (Chrome or Edge). Web pages and other extensions cannot read it, and it is not synced. The browser does not encrypt this storage, so other programs running under your user account on your computer could read it. Restrict the key to the API it is for, set a spending limit with your provider, and delete the key if you think it leaked. Ollama on your own computer needs no key.

## What Decltr does not do

- It does not collect, sell or share your data, and does not use it for anything except the action you asked for.
- It does not read the contents of web pages, only tab titles and addresses.
- It does not run code downloaded from the internet.

## Your control

- Choose another model, or use only the On-device actions, at any time.
- **Forget the saved key** in Settings removes the key and withdraws your agreement for that service.
- Removing the extension deletes everything it stored in your browser.

## Changes and contact

Changes to this policy are published in this file, with the history kept in the [repository](https://github.com/Lalitj03/decltr/commits/main/PRIVACY.md). Questions: [open an issue](https://github.com/Lalitj03/decltr/issues).
