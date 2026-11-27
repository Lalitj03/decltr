# Decltr privacy policy

Effective 27 November 2026. This policy covers the Decltr browser extension (for Chrome and Microsoft Edge) and the optional Decltr server.

Decltr is an independent, open-source hobby project. It runs on your device and the developer collects no data: there is no Decltr cloud, no account, no analytics and no advertising, and nothing you do in Decltr reaches the developer. (The optional Decltr server is a program you run yourself, on your own computer.)

In short:

- Quick actions marked *On-device* send nothing, and neither do saving, opening, exporting and importing sessions.
- AI actions, including naming a session with AI, use the model you chose. With a model that runs on your own computer (for example Ollama or LM Studio), nothing leaves your computer.
- With an online model, you use your own key, and your request and the titles and addresses of the tabs involved go straight from your browser to that service, under its terms. They never reach the developer.

## What Decltr handles, and where it goes

| Data | Where it stays or goes |
| --- | --- |
| **Your open tabs** (titles, addresses, groups) | Read in your browser to show and carry out plans. |
| **Your request** and the **titles and addresses of the tabs involved** | Only when you use an AI action or AI naming, and only to the AI model **you** chose. Everything after `?` or `#` in an address is removed first. |
| **API keys and AI settings** | Stored in this browser profile only (`chrome.storage.local`). Never synced. A key is sent only to the service it belongs to. |
| **Saved sessions, settings, undo information** | Stored in this browser profile only. Never sent anywhere. Sessions include when each tab was last used, which is used for "Archive old tabs" and for opening the most or least recently used tabs. |
| **Shared sessions** (only if you turn on sharing between browsers) | Kept by the optional Decltr server in a folder on this computer that only your user account can read, with a copy each day for 7 days, and in each browser on this computer that shares. Nothing leaves this computer. |
| **Exported files** | Saved where your browser saves downloads, only when you press Export. They hold the full address of every tab in the sessions you picked. |
| **Bookmarks** | Created in your own Chrome bookmarks, only when you apply a plan that saves bookmarks. |
| **Tab icons** | Taken from the browser's own icon store (the `favicon` permission). Decltr never loads them from the sites, so showing your tabs and sessions contacts nobody. |

Where AI requests go depends on what you choose in Settings → AI model:

- **Google Gemini**: to Google, under the [Gemini API terms](https://ai.google.dev/gemini-api/terms). With a free (unpaid) key, those terms let Google use what it receives to improve its products, and people at Google may read it. A key from a project with billing turned on is not used that way.
- **Another service** (OpenAI-compatible): to the address you entered. That service's own policy applies. An address on this computer (`localhost` or `127.0.0.1`, as with LM Studio or llama.cpp) is a program on your own computer.
- **Ollama**: to Ollama on your own computer. With a model you downloaded, everything stays there. Ollama's cloud models (names ending in `cloud`, such as `gemma4:cloud`) run on ollama.com under Ollama's terms, so Decltr treats them like any online service and asks first. Ollama can be told never to use its cloud: see [Ollama's FAQ](https://docs.ollama.com/faq#how-do-i-disable-ollama-cloud-features).
- The optional **Decltr server**: to a program on your own computer, which forwards requests to Google Gemini with the key you gave it.

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
