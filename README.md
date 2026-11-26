# Decltr

Tell Chrome how to tidy your tabs in plain English. Decltr can **group**, **ungroup**, **close**, **move to a new window** and **bookmark** the tabs in a window. It shows a plan first, and you can **undo** it afterwards.

Decltr works with the AI model you choose: **Google Gemini**, **Ollama** (fully on your computer), or **any OpenAI-compatible service** (OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, vLLM and others). There is nothing to host and nothing to install besides the extension.

```
Chrome side panel  ──►  the model you chose (Gemini, Ollama, OpenAI-compatible)
```

An optional [local server](#the-optional-local-server-advanced) can hold your key in the macOS Keychain instead, so it never enters the browser.

## Quick start

You need **Chrome 116+** and one of the models below. Load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Pin the Decltr icon and click it to open the side panel.

The panel then asks how Decltr should think. Pick one:

| Choice | What you do | Where your tab titles go |
| --- | --- | --- |
| **Google Gemini** | Paste an API key from Google AI Studio. | To Google |
| **Ollama** | Install [Ollama](https://ollama.com), run `ollama pull <model>`, then pick the model in the panel. | Nowhere. They stay on your computer. |
| **Another service** | Enter the service's address (for example `https://api.groq.com/openai/v1`), a key and a model name. | To that service |

Before anything can be sent to another computer, Decltr says what it sends and where, and waits for you to press **Agree and continue**. It asks once for each service, and again if you forget the key. Ollama on your own computer never asks, because nothing leaves it. Chrome then asks you to allow access to that one address, and to nothing else. Keys and settings are kept in this browser profile only (`chrome.storage.local`). They are never synced and never sent anywhere except to the model you chose.

The on-device quick actions and sessions work without any model. Only the AI actions need one.

**Ollama notes.** Ollama normally answers `403` to browser extensions. Decltr works around that itself, with a rule that sets the `Origin` header on requests to the Ollama address you entered, and only those. You do not need to set `OLLAMA_ORIGINS`. If your Ollama still answers 403, run it with `OLLAMA_ORIGINS=chrome-extension://* ollama serve`. Decltr asks Ollama for a context window sized to the request, because Ollama silently cuts off long prompts at its small default. Small models make more mistakes with plans, so always read the plan before pressing Apply. I have not yet tested against a real Ollama install, only a stand-in that behaves like one.

**OpenAI-compatible notes.** Decltr asks for a JSON schema first and falls back to plain JSON mode, then to a plain request, if the service rejects it. The key is optional for local servers such as LM Studio.

## The optional local server (advanced)

Choose **Decltr server (advanced)** in Settings → AI model to use a small Node server that runs on your computer and keeps a Gemini or Vertex key in the macOS Keychain. The key never enters the browser.

```
Chrome side panel  ──►  Decltr server (127.0.0.1:47821)  ──►  Google Gemini
 (extension/)            (server/, holds the API key)
```

You need **Node 20+** (nothing to `npm install`). The steps are written for **macOS**, which is the only system I have tested.

```bash
git clone https://github.com/Lalitj03/decltr && cd decltr

npm run set-key           # paste your key (the input is hidden). It is stored in your Keychain.
npm run server:install    # starts the server now, in the background, and at every login
```

The status pill at the top of the panel should say **Ready**. If it says "Server offline" or "No API key", run `npm run server:status`, which tells you what is missing.

The server only accepts requests from the Decltr extension. If you installed Decltr from the Chrome Web Store, its ID differs from the one pinned for development, so add it with `DECLTR_EXTENSION_ID` (see Configuration).

### Which key?

Either kind works, and Decltr works out which one you pasted.

| Key | Looks like | Comes from |
| --- | --- | --- |
| **Gemini API key** | starts with `AIza` | Google AI Studio |
| **Vertex AI key** | starts with `AQ.` | Google Cloud, bound to a service account with the `Vertex AI Express User` role |

If you save both, Vertex AI is used. To use the other one, set `DECLTR_PROVIDER=gemini` (or `vertex`); for the background service, set it when installing: `DECLTR_PROVIDER=gemini npm run server:install`.
To replace a key, run `npm run set-key` again, then `npm run server:restart`. A server that has no key yet notices a new one by itself.
If a key's format is not recognised, say which kind it is: `npm run set-key gemini` or `npm run set-key vertex`.

Your key stays in the macOS Keychain, never in a file or in this repo. It is sent to nobody except Google.

### Not on macOS, or you would rather not use the Keychain

Set the key in the environment and run the server in a terminal. The background-service commands and the Keychain are macOS only.

```bash
DECLTR_API_KEY=your-key npm start                    # macOS / Linux
```
```powershell
$env:DECLTR_API_KEY="your-key"; npm start             # Windows PowerShell
```

### Run it in a terminal instead of the background

`npm start` runs the server until you press Ctrl+C. If one is already running that way, `npm run server:install -- --replace` stops it and sets up the background one.

## Controlling the background server

| Command | What it does |
| --- | --- |
| `npm run server:status` | Is it installed, running and answering? Does it see your API key? |
| `npm run server:restart` | Restart it (use this after changing the code or the key) |
| `npm run server:stop` | Stop it. It **stays stopped** until you start it or log in again |
| `npm run server:start` | Start it again |
| `npm run server:logs` | Show the last lines of the log (`-- -f` follows it live) |
| `npm run server:uninstall` | Remove it from login items |

The panel can do the same: **Settings → Server** shows what is running and has **Restart** and **Stop** buttons.
They work only when the server runs as the background service, because a server you started by hand has nothing to bring it back.
Stopping asks for a second click, and the panel cannot start it again, so use `npm run server:start`.

The service restarts itself after a crash, but not after a deliberate stop. Its log is `~/Library/Logs/decltr-server.log`.
It records the path to your current `node` and to this folder, so run `npm run server:install` again if either changes.

## Updating

After pulling changes, do both of these, because the extension and the server are separate programs:

1. **Reload the extension** in `chrome://extensions`.
2. **Restart the server**: `npm run server:restart`, or Settings → Server → Restart in the panel. If you run it from a terminal instead, stop it with Ctrl+C and run `npm start` again.

If you forget the second step, the status pill in the panel turns into **Restart server**, and AI naming says the server is out of date. (An older server cannot be restarted from the panel. Use `npm run server:restart` or `npm run server:install -- --replace` once.)

## Using it

Pick a quick action or type a request such as:
- "Bookmark all recipe tabs into a folder called Recipes and close them"
- "Put everything about my Lisbon trip in one group"
- "Move all video tabs to a new window"
- "Ungroup everything, then group by project"

Each plan lists its actions with checkboxes. Expand an action to drop single tabs, then press **Apply**. **Undo** reverses the last change (closed tabs are reopened as new tabs, so scroll position and form contents are not restored).

| Quick action | Runs |
| --- | --- |
| Group by topic, Split off leisure, Full tidy-up, Regroup from scratch | AI (your chosen model) |
| Group by site, Close duplicates, Bookmark & clear, Ungroup all | On-device, nothing is sent anywhere |

**Managing groups.** The start screen lists the tab groups in the window. **Ungroup** dissolves a group and keeps its tabs open. **Close** deletes the group together with its tabs. Both show a plan first and can be undone. Unnamed groups are listed too. With the AI you can say things like "ungroup everything and regroup by project" or "delete the Shopping group".

## Sessions

The **Sessions** tab saves a window as a named workspace and reopens it later, in any window.

- **Save** stores the window and keeps its tabs open. **Save & clear** stores it, then closes those tabs (the window keeps one blank tab).
- A session keeps tab order, pinned state, and groups with their names, colors and collapsed state.
- **New window** opens the session in a fresh window. **This window** adds its tabs to the current one. If the current window only has a blank tab, that tab is replaced.
- Both opening and clearing can be undone. Click the arrow on a session to see its tabs. Deleting asks for a second click.
- **Names.** The pencil renames a session (Enter saves, Escape cancels). The sparkle button asks the AI for a name, both next to the name box when saving and inside the rename field. With "Name new sessions with AI" on (the default), a session you did not name is named by the AI a few seconds after saving. Saving never waits for it, a failure just leaves the date name, and a name you type always wins.
- **Live sessions.** When you open a session into a new window (or into a window that has no real tabs), that window follows the session: tabs you open, close, move, pin, regroup or navigate are saved back to it, a couple of seconds after each change. A card shows a green **Live** line with **Stop syncing**. Opening a live session again switches to its window instead of making a copy. The "Keep opened sessions up to date" setting turns the whole feature off.
- Syncing is careful by design: a window that is closing is never saved halfway, a window with no real tabs never empties a session, Save & clear and Undo stop the window from following the session first, and a deleted session is never recreated. The flip side is that closing a tab in a live window removes it from the session. Use **Stop syncing** if you want to experiment without changing the saved one. Adding a session to a window that already has tabs does not make that window live.
- Pinned tabs are saved and cleared only if "Include pinned tabs" is on in settings, like everywhere else in Decltr.
- Sessions live in this browser profile's extension storage (`chrome.storage.local`). They are not synced and are not sent anywhere. The only exception is optional AI naming, which sends the session's tab titles and addresses (without query strings) to your chosen model, like any other AI action. They include full URLs, so anything in a URL is stored as is.
- Pages that cannot be reopened by an extension (`javascript:`, `data:`, other extensions' pages) and blank tabs are not saved.

Bookmarks go into **Other bookmarks → Decltr → \<folder\>**. The first time a plan saves bookmarks, Chrome asks whether Decltr may use them. If you say no, nothing in that plan is changed, so tabs are never closed without being saved. Pinned tabs are left alone unless you enable them in settings.

## How the key is protected (local server)

- On macOS it is read from the Keychain by the server and held in memory. It is never sent to the extension, written to a file or logged, and it is scrubbed from error messages.
- The server binds to `127.0.0.1` only. It rejects any request whose `Origin` is not the Decltr extension, which blocks web pages you visit from using it. It also checks the `Host` header against DNS rebinding.
- The server builds the Gemini request itself from a fixed prompt and schema, so it cannot be used as a general proxy. It is also rate limited and has a request size cap.
- Give the key only the access it needs. A Vertex AI key should be restricted to the Vertex AI API and bound to a service account, and any key can be deleted from Google Cloud or AI Studio if you ever suspect it leaked.
- A process running as you could forge the headers, but it could also read your Keychain, so the server does not try to defend against that.

## Privacy

For AI actions, tab titles and URLs (origin and path only; query strings and fragments are removed in the extension, before anything is sent) go to the model you chose: Google, another service, the Decltr server, or only your own computer with Ollama. Decltr has no server of its own and collects nothing. Page titles are treated as untrusted data: the model's output is validated twice, can only reference your own tab IDs, and cannot create URLs. Nothing changes until you press Apply.

## Configuration

Environment variables for the optional server:

| Variable | Default |
| --- | --- |
| `DECLTR_PORT` | `47821` (if you change it, update `host_permissions` and `SERVER_URL` in the extension too) |
| `DECLTR_PROVIDER` | chosen from your key; set `vertex` or `gemini` to force one |
| `DECLTR_API_KEY` | your key, if you are not using the Keychain |
| `DECLTR_MODEL` | `gemini-3.5-flash-lite` |
| `DECLTR_THINKING_BUDGET` | `0` (raise for harder requests, up to 24576) |
| `DECLTR_EXTENSION_ID` | the pinned ID (comma-separated list allowed) |

## Development

```bash
npm test         # server and extension logic, using a mock of the Chrome APIs
npm run dev:ui   # preview the side panel in a normal tab: http://localhost:5173/panel
                 #   ?server=offline | nokey | billing    &tabs=many
npm run icons    # regenerate extension/icons
npm run package  # dist/decltr-<version>.zip for the Chrome Web Store, without the development "key"
```

## Licence

[MIT](LICENSE). Decltr is an independent hobby project. It is not affiliated with or endorsed by Google, Ollama, OpenAI or any other model provider. Product names belong to their owners.
