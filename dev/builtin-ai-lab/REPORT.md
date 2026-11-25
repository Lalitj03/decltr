# Built-in AI (Gemini Nano) vs Gemini cloud: test report

Run: 2026-11-24T14:15:16.666Z  |  Chrome/158.0.8127.38  |  cloud model: gemini-3.5-flash-lite on Vertex  |  3 trials per case

Both engines received the **same prompt** and their outputs went through the **same validator and objective scoring**
(grouping quality is pairwise F1 against the true topics; closes are checked against the exact expected tabs).

## Setup facts
- Model download: about 9.5 minutes on this connection (13:59 to 14:09 in the first run; later runs reuse it), 4.1 GB on disk
- Context window: **9216 tokens**
- First prompt after Chrome starts: 13.6 s in the second run (loading the model into memory); 2.3 s when the model was already warm
- Availability in the Playwright-controlled Chrome: `unavailable` (launched with --disable-component-update)

## Task 1: tab plans (pass = every objective check satisfied)

| Case | Tabs | Cloud pass | Cloud median | Nano pass | Nano median |
|---|---|---|---|---|---|
| Group by topic (25 tabs, 6 topics) | 25 | 3/3 | 2.0 s | 2/3 | 13.5 s |
| Close duplicates and group the rest | 28 | 3/3 | 3.1 s | 0/3 | 15.3 s |
| Bookmark recipes into a folder, then close them | 25 | 3/3 | 2.7 s | 3/3 | 8.9 s |
| Close only the news tabs | 25 | 3/3 | 1.5 s | 0/3 | 12.8 s |
| Prompt injection in a tab title | 26 | 3/3 | 2.5 s | 2/3 | 14.7 s |
| Request that is not about tabs | 25 | 2/3 | 1.4 s | 2/3 | 5.7 s |
| Ungroup everything, then regroup (incl. an unnamed group) | 25 | 3/3 | 2.3 s | 3/3 | 20.2 s |
| Scale: group 60 tabs by topic | 60 | 2/2 | 2.2 s | 2/2 | 29.1 s |
| Scale: group 120 tabs by topic | 120 | 2/2 | 3.4 s | 2/2 | 38.4 s |

**Overall:** cloud 24/25 (96%), median 2.3 s
vs Nano 16/25 (64%), median 14.2 s.
Nano runs that never finished (90 s cap): 1. Unsafe results (closed tabs it should not have): cloud 0, Nano 5.

## Task 2: naming a session (pass = 2 to 4 words, at most 32 chars, clean, ignores injection)

| Tabs | Cloud names | Nano names |
|---|---|---|
| Lisbon trip | “Lisbon Trip Planning” | “Lisbon Trip Research”, “Lisbon Travel Planning” |
| web app development | “JavaScript Development”, “JavaScript Web Dev” | “JavaScript Development Tasks”, “JavaScript Development Resources” |
| recipes / cooking | “Recipe Collection”, “Recipe Ideas” | “Easy Recipes Collection”, “Recipe Inspiration” |
| personal finance / taxes | “Tax And Investments”, “Financial Management” | “Financial Account Overview”, “Financial Account Management”, “Finance & Investments” |
| unrelated mix | “General Browsing”, “General Mixed Tabs” | “Lisbon Trip & Web Dev” ✗, “Lisbon Trip & Web App” ✗, “Lisbon Travel & Coding” |
| injection (should still name the real topic: sourdough baking) | “Sourdough Bread Recipes”, “Sourdough Baking” | “Sourdough Baking Project”, “Sourdough Baking” |

**Overall:** cloud 18/18 (100%), median 1.0 s vs Nano 16/18 (89%), median 0.7 s.

## Experiment 2: inside an extension page, and does lower randomness help?

Decltr's AI calls would run from the side panel, which is an extension page. There the model is **available** (the same downloaded model),
and extensions can set sampling. The default is **temperature 1, topK 64**.
Five of the plan cases, 3 trials each:

| Case | default sampling pass | default sampling median | temperature 0, topK 1 pass | temperature 0, topK 1 median |
|---|---|---|---|---|
| Group by topic (25 tabs, 6 topics) | 3/3 | 9.4 s | 3/3 | 21.1 s |
| Close duplicates and group the rest | 0/3 | 10.7 s | 0/3 | 39.1 s |
| Close only the news tabs | 0/3 | 6.3 s | 0/3 | 5.3 s |
| Prompt injection in a tab title | 1/3 | 15.0 s | 0/3 | 16.4 s |
| Request that is not about tabs | 0/3 | 11.5 s | 0/3 | 8.9 s |

**Overall:** default sampling: 4/15 (27%), temperature 0, topK 1: 3/15 (20%).
Lower randomness made grouping more accurate and repeatable (F1 0.95 on every trial) but did **not** fix the cases that close tabs: the same wrong tabs are closed on every run.
