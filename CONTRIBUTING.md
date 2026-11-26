# Contributing

Thanks for helping. Bug reports, fixes and small focused features are all welcome. For a larger change, open an issue first so we can agree on the approach.

## Setup

You need Chrome 116+ and Node 20+. There is nothing to `npm install`.

```bash
npm test         # all tests, using a mock of the Chrome APIs
npm run dev:ui   # the side panel in a normal tab with fake data: http://localhost:5173/panel
```

Load `extension/` as an unpacked extension to try it in Chrome (see the README).

## Ground rules

- **Treat the model as untrusted.** Its answers go through `normalizePlan` and the panel's `sanitizePlan`. Never let model output create URLs, pick tab IDs that were not offered, or skip the plan the person sees.
- **Clean data before it leaves the browser.** Tabs are stripped of query strings and fragments in `extension/lib/ai/` before any request.
- **Nothing is sent without agreement.** New providers must go through `consentTarget` / `hasConsent`.
- **No remote code.** Everything the extension runs ships in the package. This is a Chrome Web Store rule.
- **Ask for the narrowest permission.** New host access goes in `optional_host_permissions` and is requested when needed.
- **Never commit a real key**, a `.pem` file or personal data. Tests use obviously fake keys.
- Keep user-facing text plain and short.
- Add or update tests for behaviour changes, and run `npm test` before opening a pull request.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
