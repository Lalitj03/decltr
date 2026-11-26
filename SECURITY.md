# Security

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/Lalitj03/decltr/security/advisories/new), not in a public issue.

Helpful to include: what you found, how to reproduce it, and the Decltr version (shown in `chrome://extensions`). This is a hobby project, so I reply when I can, usually within a week.

Things that are in scope:

- An API key leaving the browser for anywhere except its own service, or appearing in logs or error messages.
- Tab details being sent without the person's agreement, or to a place they did not choose.
- A web page or a model's answer making Decltr do something the person did not approve (for example opening, closing or bookmarking tabs outside the plan they saw).
- The optional local server accepting requests from anything other than the Decltr extension.

**Never include a real API key in a report.** If you think a key leaked, delete it in Google AI Studio or with your provider first.
