# Decltr

Tell Chrome how to tidy your tabs in plain English. Decltr can **group**, **ungroup**, **close**, **move to a new window** and **bookmark** the tabs in a window. It shows a plan first, and you can **undo** it afterwards.

```
Chrome side panel  ──►  Decltr server (127.0.0.1:47821)  ──►  Vertex AI (Gemini)
 (extension/)            (server/, holds the API key)
```

Nothing is hosted anywhere. The server runs on your Mac, and the API key never enters the browser.

## Setup

**1. Load the extension**
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension/` folder.
3. Pin the Decltr icon. Clicking it opens the side panel.

The extension ID is pinned to `jldfhgcphcbkmjmlkkioebphdaipkcjf`. The server only accepts requests from that ID.

**2. Run the server**

The server must be running for AI actions (the on-device quick actions and sessions work without it). Pick one:

```bash
npm run server:install     # recommended: runs in the background and starts at every login
npm start                  # or: runs in this terminal only, until you press Ctrl+C
```

If a server is already running from a terminal, `npm run server:install -- --replace` stops it and sets up the background one.

**3. API key**
By default Decltr calls **Vertex AI**, so usage is billed to your Google Cloud project and its credits. Vertex only accepts an API key that is bound to a service account with the `Vertex AI Express User` role:
```bash
gcloud services api-keys create --display-name="Decltr (Vertex AI)" \
  --service-account=<service-account-email> --api-target=service=aiplatform.googleapis.com
```
The key is stored in the macOS Keychain under the service name `decltr` (account `vertex-api-key`). To store or replace it:
```bash
npm run set-key        # prompts with hidden input
```
On other platforms, set `DECLTR_API_KEY` in the server's environment instead.

To use the Gemini Developer API (AI Studio, prepaid) instead, set `DECLTR_PROVIDER=gemini` and run `npm run set-key gemini`.

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
| Group by topic, Split off leisure, Full tidy-up, Regroup from scratch | AI (Gemini) |
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
- Sessions live in this browser profile's extension storage (`chrome.storage.local`). They are not synced and are not sent to the Decltr server. The only exception is optional AI naming, which sends the session's tab titles and addresses (without query strings) to Gemini, like any other AI action. They include full URLs, so anything in a URL is stored as is.
- Pages that cannot be reopened by an extension (`javascript:`, `data:`, other extensions' pages) and blank tabs are not saved.

Bookmarks go into **Other bookmarks → Decltr → \<folder\>**. Pinned tabs are left alone unless you enable them in settings.

## How the key is protected

- It is read from the Keychain by the server and held in memory. It is never sent to the extension, written to a file or logged, and it is scrubbed from error messages.
- The server binds to `127.0.0.1` only. It rejects any request whose `Origin` is not the Decltr extension, which blocks web pages you visit from using it. It also checks the `Host` header against DNS rebinding.
- The server builds the Gemini request itself from a fixed prompt and schema, so it cannot be used as a general proxy. It is also rate limited and has a request size cap.
- The Google Cloud key is restricted to the Vertex AI API and bound to a service account.
- A process running as you could forge the headers, but it could also read your Keychain, so the server does not try to defend against that.

## Privacy

For AI actions, tab titles and URLs (origin and path only; query strings and fragments are removed) are sent to Google (Vertex AI). Page titles are treated as untrusted data: the model's output is validated twice, can only reference your own tab IDs, and cannot create URLs. Nothing changes until you press Apply.

## Configuration

Environment variables for the server:

| Variable | Default |
| --- | --- |
| `DECLTR_PORT` | `47821` (if you change it, update `host_permissions` and `SERVER_URL` in the extension too) |
| `DECLTR_PROVIDER` | `vertex` (or `gemini`) |
| `DECLTR_MODEL` | `gemini-3.5-flash-lite` |
| `DECLTR_THINKING_BUDGET` | `0` (raise for harder requests, up to 24576) |
| `DECLTR_EXTENSION_ID` | the pinned ID (comma-separated list allowed) |

## Development

```bash
npm test         # server and extension logic, using a mock of the Chrome APIs
npm run dev:ui   # preview the side panel in a normal tab: http://localhost:5173/panel
                 #   ?server=offline | nokey | billing    &tabs=many
npm run icons    # regenerate extension/icons
```
