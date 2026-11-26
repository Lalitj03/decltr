# Chrome Web Store listing

Copy these into the [developer dashboard](https://chrome.google.com/webstore/devconsole). Upload `dist/decltr-<version>.zip` from `npm run package`.

## Store listing tab

**Name:** Decltr

**Summary** (from the manifest, 104 characters):
Tell Decltr how to tidy your tabs in plain English. Group, close, move to a new window or bookmark them.

**Category:** Workflow & Planning

**Language:** English

**Description:**

```
Too many tabs? Tell Decltr what you want in plain English, and it tidies the current window for you.

• "Put everything about my Lisbon trip in one group"
• "Bookmark all recipe tabs into a folder called Recipes and close them"
• "Move all video tabs to a new window"
• "Ungroup everything, then group by project"

Decltr always shows its plan first. You can switch off any step or drop single tabs, then press Apply. Undo puts things back.

WORKS WITH THE AI YOU CHOOSE
• Google Gemini, with your own API key
• Ollama, running on your own computer, so nothing leaves it
• Any OpenAI-compatible service: OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, vLLM and others

NO AI NEEDED FOR
• Group by site, close duplicates, bookmark and clear, ungroup all
• Archive old tabs: save the tabs you have not used for a week, a month or longer as a session, then close them
• Sessions: save a window as a named workspace, clear it, and reopen it later in any window, all of it or just the groups or tabs you pick. An opened session keeps itself up to date.

BUILT FOR HUNDREDS OF TABS
• Big windows are planned by AI in parts, with progress you can follow and stop
• Big sessions open without loading every tab, so opening 650 tabs does not run out of memory
• A window with hundreds of tabs gets suggestions to make it lighter

PRIVATE BY DESIGN
• No account, no analytics, no server of its own.
• Tab titles and addresses go only to the AI model you chose, and only when you use an AI action. Everything after "?" or "#" in an address is removed first.
• Decltr asks before sending anything to another computer.
• Your API key stays in this browser.
• Open source under the MIT licence: https://github.com/Lalitj03/decltr

Decltr is an independent project. It is not affiliated with or endorsed by Google, Ollama, OpenAI or any other AI provider.
```

**Graphics:** `store/screenshot-1.png` to `store/screenshot-4.png` (1280x800), `store/promo-440x280.png`, icon `extension/icons/icon128.png`.

**Official URL / homepage:** https://github.com/Lalitj03/decltr

**Support URL:** https://github.com/Lalitj03/decltr/issues

## Privacy tab

**Single purpose:**

```
Decltr organizes the tabs in the current browser window (grouping, ungrouping, closing, moving to a new window, bookmarking, and saving or reopening them as sessions), following the user's plain-English request or a quick action.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `tabs` | Reads the titles and addresses of the tabs in the window so the user's request can be turned into a plan, and closes, moves and reopens tabs when the user applies it. |
| `tabGroups` | Creates, names, colors, ungroups and restores tab groups, which is the main thing Decltr does. |
| `sidePanel` | Decltr's whole interface is a side panel next to the user's tabs. |
| `storage` | Keeps the user's settings, saved sessions, undo information and the AI model settings they entered, locally in this browser. |
| `declarativeNetRequestWithHostAccess` | Only when the user chooses Ollama: sets the Origin header on Decltr's own requests to the Ollama address the user entered, because Ollama refuses browser-extension origins by default. One rule, limited to that address and to Decltr's requests, removed when the user picks another model. |
| `bookmarks` (optional) | Asked for only the first time the user applies a plan that saves bookmarks. Creates bookmarks in an "Other bookmarks → Decltr" folder, and removes them again on undo. |
| Host `http://127.0.0.1:47821/*` | The optional Decltr server that some users run on their own computer to keep their API key in the macOS Keychain. It only listens on this computer. |
| Optional hosts (`generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, `localhost`, `127.0.0.1`, `http://*/*`, `https://*/*`) | Requested one address at a time, only for the AI service the user chose and typed in (Google Gemini, Ollama, or an OpenAI-compatible service the user names). Nothing is requested until the user saves that choice. |

**Remote code:** No, I am not using remote code. All code is in the package. Model answers are treated as data, validated, and never run.

**Data usage** (tick these):

- **Web history**: tab titles and addresses are sent to the AI service the user chose, only when they use an AI action.
- **Authentication information**: the API key the user enters is stored in this browser and sent only to the service it belongs to.

Then tick all three certifications: not sold to third parties, not used or transferred for purposes unrelated to the single purpose, not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/Lalitj03/decltr/blob/main/PRIVACY.md

## Distribution tab

Public, all regions, free.

## Test instructions (for reviewers)

```
No account or login is needed.

Without any AI: open the side panel from the toolbar icon. "Group by site", "Close duplicates", "Bookmark & clear" and "Ungroup all" (marked On-device) work immediately. The Sessions tab saves and reopens windows. Every change shows a plan first and can be undone.

With AI: Decltr does not include a key or a hosted service. Open Settings (top right), choose "Google Gemini", paste any Gemini API key from https://aistudio.google.com/apikey, press "Save and test", then "Agree and continue" and allow access. Then try "Group by topic" or type "Put all shopping tabs in one group". Ollama and OpenAI-compatible services can be tested the same way if available.

The "Decltr server" option is for users who run the optional open-source server on their own computer. It is not needed to use the extension.
```

## After the first upload

1. The store gives the extension its own ID. If you use the optional server with the store version, allow that ID too, for example `DECLTR_EXTENSION_ID=jldfhgcphcbkmjmlkkioebphdaipkcjf,<store id> npm run server:install`.
2. To keep the same ID for your unpacked development copy, you can copy the public key from the dashboard's Package tab into `manifest.json` as `"key"`. `npm run package` removes it from uploads either way.
