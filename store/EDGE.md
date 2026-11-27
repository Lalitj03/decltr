# Microsoft Edge Add-ons submission

Registration and publishing are free. Sign in at https://partner.microsoft.com/dashboard/microsoftedge/overview with a Microsoft or GitHub account, register as an individual developer, then choose **Create new extension**.

## 1. Package

Run `npm run package` and upload `dist/decltr-<version>-store.zip`. It has no development `key`, so Edge assigns its own extension ID.

## 2. Availability

Visibility: **Public**. Markets: **all markets**.

## 3. Properties

- **Category:** Productivity
- **Privacy policy:** yes, the extension sends data. URL: https://github.com/Lalitj03/decltr/blob/main/PRIVACY.md
- **Website:** https://github.com/Lalitj03/decltr
- **Support contact:** https://github.com/Lalitj03/decltr/issues
- **Mature content:** No

## 4. Store listing (English)

The name and short description come from the manifest.

**Description** (plain text, no bullet characters, because Edge has rejected those). The listing's text can be changed in Partner Center at any time; the short description under the name comes from the manifest, so it changes only with a new package.

```
Tidy your tabs in plain English. Tell Decltr what you want, and it tidies the current window for you. For example: "Put everything about my Lisbon trip in one group", "Bookmark all recipe tabs into a folder called Recipes and close them", "Move all video tabs to a new window", or "Ungroup everything, then group by project".

Runs on your device and collects no data. Decltr is an independent project with no cloud, no account, no analytics and no ads, so nothing you do in it ever reaches us. All of its code is public under the MIT licence: https://github.com/Lalitj03/decltr

Every feature can run on your own computer, AI included. Use a model on your computer, such as Ollama, LM Studio or llama.cpp, and nothing leaves it. If you prefer an online AI such as Google Gemini, OpenAI, OpenRouter or Groq, you use your own key, and the titles and addresses of the tabs involved go straight from your browser to that provider, never to us. Everything after "?" or "#" in an address is removed first, and your API key stays in this browser.

Many features need no AI and never send anything: group by site, close duplicates, archive old tabs, bookmark and clear, and ungroup all. Sessions work without AI too.

Decltr always shows its plan first. You can switch off any step or drop single tabs, then press Apply. Undo puts things back.

Sessions save a window as a named workspace, clear it, and reopen it later in any window, all of it or just the groups or tabs you pick. An opened session keeps itself up to date. Archive old tabs saves the tabs you have not used for a week, a month or longer as a session, then closes them. Export sessions to a file as a backup or to share them, and import Decltr files, OneTab exports or any list of links. Advanced: share sessions between Edge, Chrome and other browsers on this computer, through the optional open-source Decltr server. Shared sessions stay on this computer.

Built for hundreds of tabs. Big windows are planned by AI in parts, with progress you can follow and stop. Big sessions open without loading every tab, so opening 650 tabs does not run out of memory. A window with hundreds of tabs gets suggestions to make it lighter.

Bookmark access is asked for only the first time you save bookmarks. Tab icons come from the browser itself, never from the sites.

Decltr is an independent hobby project. It is not affiliated with or endorsed by Microsoft, Google, Ollama, OpenAI or any other AI provider.
```

**Images:**

| Field | File |
| --- | --- |
| Extension logo (300x300) | `store/logo-300.png` |
| Small promotional tile (440x280) | `store/promo-440x280.png` |
| Large promotional tile (1400x560) | `store/promo-1400x560.png` |
| Screenshots (1280x800) | `store/screenshot-1.png` to `screenshot-5.png`, in that order (the first one is about privacy) |

**Search terms** (at most 7 terms and 21 words):

```
tab manager; tab groups; organize tabs; close duplicate tabs; local AI; Ollama; open source
```

## 5. Notes for certification

```
No account or login is needed.

Without any AI: click the toolbar icon to open the sidebar. "Group by site", "Close duplicates", "Bookmark & clear" and "Ungroup all" (marked On-device) work immediately. The Sessions tab saves and reopens windows. Every change shows a plan first and can be undone.

With AI: Decltr does not include a key or a hosted service. Open Settings (top right), choose "Google Gemini", paste any Gemini API key from https://aistudio.google.com/apikey, press "Save and test", then "Agree and continue" and allow access. Then try "Group by topic" or type "Put all shopping tabs in one group". Ollama and OpenAI-compatible services can be tested the same way if available.

Permissions: tabs and tabGroups to read and organize the window's tabs; sidePanel for the interface; storage for settings and sessions kept locally; favicon to show each tab's icon from the browser's own icon store, so the panel never loads icons from the sites; declarativeNetRequestWithHostAccess only when the user picks Ollama, to set the Origin header on Decltr's own requests to the Ollama address the user entered; bookmarks is optional and asked for on first use. Host access for an AI service is optional and asked for one address at a time, only for the service the user chooses. The fixed host 127.0.0.1:47821 is an optional open-source helper some users run on their own computer; it can also share sessions between the user's browsers on that computer. alarms is used only when that sharing is on, to check for changes every few minutes. unlimitedStorage lets saved sessions hold thousands of tabs.

No remote code is used. Model answers are treated as data, validated, and never run.

The "Decltr server" option is for users who run the optional open-source server on their own computer. It is not needed to use the extension.
```

## After it is published

1. The listing is https://microsoftedge.microsoft.com/addons/detail/decltr/ohffgmfbgpkiaapaidcakhpkhllmhopn, linked from the README.
2. The Edge store ID (`ohffgmfbgpkiaapaidcakhpkhllmhopn`) is already allowed by the optional server. Users only need `npm run server:restart` after updating.
3. For updates, raise the version, run `npm run package`, and in Partner Center choose **Update** on the extension's Packages page. Each package needs a higher version than the last one uploaded.
