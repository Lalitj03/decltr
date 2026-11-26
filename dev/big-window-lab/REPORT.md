# Planning big windows

Why grouping stopped at about 100 tabs, and how Decltr plans windows with hundreds of tabs now.

`window.mjs` makes a reproducible test window: tabs from 20 topics opened in bursts, plus one-off tabs and
duplicates, with the true topic of every tab so a plan can be scored. "Grouped" is the share of topic tabs
that ended up in a group; "correct" is the share of grouped tabs whose group is mostly their own topic.
All runs used Gemini 3.5 Flash-Lite with thinking off.

## Before

The panel sent at most 300 tabs. With 300, the model made no plan at all and replied that there were too many
open tabs (`raw.mjs`). With 100 tabs, it grouped 62%.

## Approaches tried on 650 tabs (several runs each)

| Approach | Grouped | Correct | Time | File |
| --- | --- | --- | --- | --- |
| One request (300 tabs sent) | 0% | – | 1 s | `baseline.mjs` |
| Plan groups from an overview, then sort tabs into them | 38–81% | 72–89% | 10–64 s | `two-step.mjs` |
| Plan parts one after another, passing group names on | 42–86% | 81–99% | 16–23 s | `carry.mjs` |
| Plan parts of 80 at once, then merge similar groups | 93–96% | 96–97% | 11–19 s | `in-parts.mjs` |

The last one is what ships (`extension/lib/ai/parts.js`). It uses the normal planner for both steps, so it
works with every provider, including the optional server, and every answer is checked like a single plan.

## What the shipped version needed (`real.mjs`)

- **Merging in passes.** One merge request sometimes merged only a few of 70 to 100 proposed groups, or none.
  Merging now repeats, with the list in another order, until a pass combines nothing (at most 3 passes).
  Before: 30 to 96 final groups for the same window. After: 21 to 43, with 90 to 98% grouped.
- **A stricter merge instruction**, so related but different topics ("Rust" and "React") stay apart.
- **Retries in another order.** Gemini sometimes cuts off an answer that is mostly a long list of numbers
  (finishReason `RECITATION`). The same request with the tabs reversed goes through.
- **Cut-off answers** (`MAX_TOKENS`) are planned again in two halves.

Around the cut-off, one request and two parts did equally well (60 and 80 tabs: 84–100% grouped either way),
so windows up to 80 tabs still use one request.
