# Changelog

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
