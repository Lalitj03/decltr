# Decltr brand guide

What Decltr says about itself, the proof behind each claim, and how it looks. The store texts are in [EDGE.md](EDGE.md) and [LISTING.md](LISTING.md). The graphics are rendered from `dev/store/frame.html` by `node dev/store/capture.mjs`.

Every claim here is true of the code in this repository, and the claims table says why. If a change to the code would make a claim false, change the claim in the same commit.

## Positioning

Decltr tidies browser tabs from plain-English requests. It is independent and open source: there is no Decltr cloud, no account, no analytics and no ads, so none of your data reaches its developer. You choose the AI. A model on your own computer keeps everything on it. An online model with your own key receives tab titles and addresses, and only after you agree. Many features need no AI at all.

It is for people who keep many tabs open (for research, development, study or planning a trip) and care where their data goes, including people who already run local models with Ollama or LM Studio.

## Messages, in this order

1. **What it does.** Tidy your tabs in plain English.
2. **Why you can trust it.** Independent and open source: no Decltr cloud, no account, no analytics.
3. **The privacy promise.** With local AI, nothing leaves your computer.
4. **Choice.** Use the AI you choose, or none: many actions run on your device.

Start with 1 so people know what Decltr is, and follow with 2 and 3 straight away. Wherever privacy is the topic (the first screenshot, the privacy part of a listing), lead with 3.

## Taglines

| Where | Line |
| --- | --- |
| Main line, everywhere | Tidy your tabs in plain English. |
| Under the main line | Open source, with no account and no Decltr cloud. |
| Privacy promise | With local AI, nothing leaves your computer. |
| Privacy headline (first screenshot) | Your tabs go only where you send them. |
| Choice | Use the AI you choose, or none. |
| Chips and badges | Open source · No account · Local AI |

## Words

- **Local AI**, or "a model on your own computer": Ollama with a downloaded model, or LM Studio, llama.cpp and similar at a `localhost` address.
- **Online AI**, or "an online model": Google Gemini, OpenAI, OpenRouter, Groq and any other service on the internet.
- **On-device**: the quick actions that use no AI. Use it only for those, as the panel does.
- **Decltr cloud**: what Decltr does not have. Say "no Decltr cloud" rather than "no server", because the optional helper that runs on your own computer is called the Decltr server.

## Claims and their proof

| Claim | Why it is true | Limits |
| --- | --- | --- |
| No Decltr cloud. The developer receives none of your data. | The extension contacts only the AI service you chose and, if you run it, the optional Decltr server on your own computer (127.0.0.1). It has no analytics or error-reporting code. `fetch` appears only in `lib/api.js` and `lib/share.js` (both for the local server) and in the AI backends. | Any new request, image, font or script from the internet breaks this. |
| No account. | There is nothing to sign in to. | |
| Open source, MIT licence. | `LICENSE`. The store zip is built from `extension/` by `npm run package`. | |
| No remote code. | Everything runs from the package. Model answers are checked as data and never run. | |
| On-device actions send nothing. | Group by site, close duplicates, archive old tabs, bookmark and clear, and ungroup all are planned in the browser (`lib/plan.js`, `lib/archive.js`). Saving, opening, exporting and importing sessions stay in the browser too. | Saving a session can ask the AI for a name ("Name new sessions with AI"). That is an AI action. |
| With local AI, nothing leaves your computer. | For a model at `localhost`, `127.0.0.1` or `[::1]`, there is nothing to agree to (`consentTarget` is empty) and nothing else is contacted. Tab icons come from the browser's own icon store: `node dev/share-lab/favicons.mjs` finds no request about the tabs in Chrome's and Edge's network logs. | Not for Ollama's cloud models (names ending in `cloud`) or a model on another computer on your network. Decltr asks first for those. Opening a tab still loads its site. The browser's own services, such as sync, are outside Decltr. |
| An online model gets data only after you agree. | Agreement is checked before every request, once per destination (`hasConsent`, tested in `test/backends.test.js`). It receives your request and, for the tabs involved, their titles, addresses without the part after `?` or `#`, group names, and whether a tab is the active one or playing sound. | The optional Decltr server is set up by hand in a terminal with its own key, and forwards to Google Gemini without the panel asking. |
| Your API key stays in this browser. | It is kept in `chrome.storage.local`, never synced, and sent only to the service it belongs to. | It is not encrypted on disk. Never say "encrypted" or "secure vault". |
| Sharing between browsers stays on this computer. | The optional server keeps shared sessions in a folder only your user account can read. | |

## Say this, not that

| Avoid | Why | Say instead |
| --- | --- | --- |
| 100% private, completely private, zero data | Online models receive tab titles and addresses. | With local AI, nothing leaves your computer. |
| No server | The optional local helper is called the Decltr server. | No Decltr cloud. |
| On-device AI | The panel says On-device for actions without AI, and Chrome's built-in AI is not supported. | Local AI, or a model on your own computer. |
| Nothing ever leaves your browser | Online AI, sharing and export are exceptions. | Name the case: on-device actions, local AI, online AI. |
| Encrypted, secure storage | The key is stored unencrypted in the browser profile. | Your key stays in this browser and goes only to its service. |
| Anonymous | An online service sees what it receives, and the key identifies your account. | Only the tabs involved, and only after you agree. |
| Works with Gemini Nano, or Chrome's built-in AI | Not built. | |
| Partnered with, endorsed by | Decltr is not affiliated with any AI company. | Works with Ollama, Gemini and others. |
| Free forever | A promise about the future. | Free. |

## Voice

- Plain, specific and calm. Say what happens to data in concrete words ("the titles and addresses of the tabs involved") instead of adjectives ("secure", "private").
- Short sentences. No hype words such as "revolutionary", "seamless", "supercharge" or "magic".
- "Decltr" in product text. When the developer speaks, as in notes in the README, "I".
- Spelling as in the rest of the docs ("licence").

## Ready-made descriptions

One line (74 characters):

> Decltr tidies your browser tabs in plain English. Open source, no account.

Short (33 words):

> Decltr is a free, open-source extension for Chrome and Edge that tidies your tabs from plain-English requests. It has no account and no cloud of its own, and it works with local AI.

Medium (61 words):

> Decltr is a free, open-source extension for Chrome and Edge. Tell it what you want in plain English, and it groups, closes, bookmarks or saves your tabs. It shows a plan first, and Undo puts things back. Decltr has no account and no cloud of its own. With a model on your own computer, such as Ollama, nothing leaves your computer.

Long (120 words):

> Decltr is a free, open-source (MIT) extension for Chrome and Microsoft Edge that tidies your tabs from plain-English requests, such as "put everything about my Lisbon trip in one group". It shows a plan first, and Undo puts things back. Decltr is an independent hobby project with no cloud, no account, no analytics and no ads, so none of your data reaches its developer. You choose the AI. With a model on your own computer, such as Ollama, LM Studio or llama.cpp, nothing leaves your computer. With Google Gemini or another online service and your own key, that service receives the titles and addresses of the tabs involved, and only after you agree. Many features need no AI at all.

GitHub repository description (the gear next to **About** on the repository page):

> Tidy your browser tabs in plain English. Open-source Chrome and Edge extension with no account and no Decltr cloud. Works with Ollama, LM Studio, Gemini or any OpenAI-compatible model.

Topics: `chrome-extension`, `edge-extension`, `tab-manager`, `tab-groups`, `ollama`, `local-ai`, `privacy`, `llm`.

## Look

**Logo.** Three rounded lines, getting shorter, on an indigo-to-violet rounded square (`extension/icons/`, made by `npm run icons`). On the gradient background, place it on a white rounded tile, as in the promo tiles. Do not recolour, stretch or decorate it, and keep clear space of at least half its width around it.

**Colours** (the same as the panel):

| Name | Hex | Use |
| --- | --- | --- |
| Indigo | `#6366f1` | Gradient start, icons, links |
| Violet | `#a855f7` | Gradient end |
| Ink | `#1b1b2f` | Headlines |
| Slate | `#4b4b66` | Body text on light backgrounds |
| Muted | `#6b6b84` | Secondary text |
| Mist | `#f7f7fb`, `#f3ecff`, `#eef0ff` | Light backgrounds |
| Stays green | `#15803d` on `#ecfdf3` | "Stays in your browser", "Stays on your computer" |
| Ask amber | `#b45309` on `#fff7e6` | "Only after you agree" |

The gradient runs at 135°, from indigo to violet. On text, use it only for the key phrase of a headline.

**Type.** The system UI font (San Francisco, Segoe UI, Roboto). Headlines bold with tight letter spacing (−0.02em), body text regular.

**Pictures.** Real panel screenshots from the dev preview, never mock-ups of features that do not exist. Rounded corners (18 px), a soft shadow, and a light lavender background.

## Files

| File | Size | Used for |
| --- | --- | --- |
| `store/screenshot-1.png` | 1280x800 | Privacy: where your tabs go. Always the first screenshot. |
| `store/screenshot-2.png` | 1280x800 | A plan from a plain-English request |
| `store/screenshot-3.png` | 1280x800 | Sessions |
| `store/screenshot-4.png` | 1280x800 | Choice of AI (Ollama in settings) |
| `store/screenshot-5.png` | 1280x800 | Hundreds of tabs |
| `store/promo-440x280.png` | 440x280 | Small promo tile (Edge Add-ons, Chrome Web Store) |
| `store/promo-1400x560.png` | 1400x560 | Large promo tile (Edge Add-ons), marquee (Chrome Web Store), top of the README |
| `store/social-1280x640.png` | 1280x640 | GitHub social preview (repository Settings → General → Social preview) |
| `store/logo-300.png` | 300x300 | Extension logo on Edge Add-ons |

To change a graphic, edit `dev/store/frame.html` and run `node dev/store/capture.mjs`. Add `frames` to keep the panel images as they are. The privacy and settings panel images come from the preview with `?ai=ollama`. The others are 440x800 screenshots of the preview (`npm run dev:ui`).

## Before publishing a claim

1. Is it true for every AI choice? If not, name the condition, as in "with local AI".
2. After changing anything that loads content into the panel or makes a request, run `node dev/share-lab/favicons.mjs` and look at `git grep -n "fetch(" extension`.
3. Update [PRIVACY.md](../PRIVACY.md) in the same change.
