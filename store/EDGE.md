# Microsoft Edge Add-ons submission

Registration and publishing are free. Sign in at https://partner.microsoft.com/dashboard/microsoftedge/overview with a Microsoft or GitHub account, register as an individual developer, then choose **Create new extension**.

## 1. Package

Run `npm run package` and upload `dist/decltr-<version>.zip`. It has no development `key`, so Edge assigns its own extension ID.

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

**Description** (plain text, no bullet characters, because Edge has rejected those):

```
Too many tabs? Tell Decltr what you want in plain English, and it tidies the current window for you. For example: "Put everything about my Lisbon trip in one group", "Bookmark all recipe tabs into a folder called Recipes and close them", "Move all video tabs to a new window", or "Ungroup everything, then group by project".

Decltr always shows its plan first. You can switch off any step or drop single tabs, then press Apply. Undo puts things back.

Works with the AI you choose. Use Google Gemini with your own API key, Ollama running on your own computer so nothing leaves it, or any OpenAI-compatible service such as OpenAI, OpenRouter, Groq, LM Studio, llama.cpp or vLLM.

Many features need no AI at all. Group by site, close duplicates, bookmark and clear, and ungroup all work on your device. Sessions let you save a window as a named workspace, clear it, and reopen it later in any window. An opened session keeps itself up to date.

Private by design. There is no account, no analytics and no server of its own. Tab titles and addresses go only to the AI model you chose, and only when you use an AI action. Everything after "?" or "#" in an address is removed first. Decltr asks before sending anything to another computer, and your API key stays in this browser. Bookmark access is asked for only the first time you save bookmarks.

Decltr is open source under the MIT licence: https://github.com/Lalitj03/decltr

Decltr is an independent project. It is not affiliated with or endorsed by Microsoft, Google, Ollama, OpenAI or any other AI provider.
```

**Images:**

| Field | File |
| --- | --- |
| Extension logo (300x300) | `store/logo-300.png` |
| Small promotional tile (440x280) | `store/promo-440x280.png` |
| Large promotional tile (1400x560) | `store/promo-1400x560.png` |
| Screenshots (1280x800) | `store/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png` |

**Search terms** (at most 7 terms and 21 words):

```
tab manager; tab groups; organize tabs; AI tabs; close duplicate tabs; sessions; Ollama
```

## 5. Notes for certification

```
No account or login is needed.

Without any AI: click the toolbar icon to open the sidebar. "Group by site", "Close duplicates", "Bookmark & clear" and "Ungroup all" (marked On-device) work immediately. The Sessions tab saves and reopens windows. Every change shows a plan first and can be undone.

With AI: Decltr does not include a key or a hosted service. Open Settings (top right), choose "Google Gemini", paste any Gemini API key from https://aistudio.google.com/apikey, press "Save and test", then "Agree and continue" and allow access. Then try "Group by topic" or type "Put all shopping tabs in one group". Ollama and OpenAI-compatible services can be tested the same way if available.

Permissions: tabs and tabGroups to read and organize the window's tabs; sidePanel for the interface; storage for settings and sessions kept locally; declarativeNetRequestWithHostAccess only when the user picks Ollama, to set the Origin header on Decltr's own requests to the Ollama address the user entered; bookmarks is optional and asked for on first use. Host access for an AI service is optional and asked for one address at a time, only for the service the user chooses. The fixed host 127.0.0.1:47821 is an optional open-source helper some users run on their own computer.

No remote code is used. Model answers are treated as data, validated, and never run.

The "Decltr server" option is for users who run the optional open-source server on their own computer. It is not needed to use the extension.
```

## After it is published

1. Copy the Edge Add-ons link into the README.
2. If you use the optional server with the Edge store version, allow its ID too, for example `DECLTR_EXTENSION_ID=jldfhgcphcbkmjmlkkioebphdaipkcjf,<edge id> npm run server:install`.
3. For updates, raise the version, run `npm run package`, and in Partner Center choose **Update** on the extension's Packages page.
