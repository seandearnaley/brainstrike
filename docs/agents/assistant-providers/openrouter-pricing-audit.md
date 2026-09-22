# OpenRouter pricing overrides — evidence

Supports `docs/agents/assistant-providers.md` § "Read the BASE rate, not the rate in force right now". The two override shapes, the cheapest-band rule, and the audit script.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1215-1260); append rather than
rewrite.

---

`pricing.prompt` / `pricing.completion` are the rate AT READ TIME. Two kinds
of `pricing.overrides` entry move them, and both have already put a wrong
number in the catalog:

| override key | meaning | trap |
| --- | --- | --- |
| `min_prompt_tokens` | long-context tier (63 live routes) | a size surcharge this schema does not carry (BST-1708) |
| `utc_days` / `utc_start` / `utc_end` | time-of-day SURGE band (2 live routes) | inside a peak window the top-level rate IS the surge rate |

Those are the only two shapes, and the audit recognises each by POSITIVE
evidence: of the 65 live routes carrying `pricing.overrides` on 2026-09-10,
63 are `min_prompt_tokens` tiers, 2 are clock bands, and 0 are anything else.
An entry matching neither — or mixing both — throws. Classifying by
elimination is fail-open here, because the band reader defaults every absent
UTC field: an unrecognised entry would become a band covering the whole week
and could then WIN the cheapest-band comparison and become the recorded base
rate. A third shape gets read by a human and taught to the script.

`tencent/hy3` shipped at 0.132 / 0.528 — its 00:00-16:00 UTC band — because
BST-1696 read the API during that window. Nothing in the response says so:
the base 0.0825 / 0.33 is only visible in `overrides`. A third trap needs no
overrides at all — `<id>:batch`, `<id>:free` and `<id>:nitro` are SEPARATE
routes with their own prices, and `google/gemini-3.7-flash` and
`z-ai/glm-5.3-flash` both shipped carrying their `:batch` twin's rate.

So: record the standard route's base rate. On a route with clock bands that
means THE CHEAPEST BAND, not "the rate outside every band" — a payload whose
bands leave part of the week uncovered is rejected outright, so there is no
outside, and it is not "the band covering most of the week" either, because
`tencent/hy3` surges for 16 hours in every 24 and its modal band IS the surge.
The known limit of the cheapest-band rule is a promotional window priced BELOW
the standing rate, which would be read as the base; nothing live does that
(2026-09-10) and the payload carries no field separating a discount window
from a surge window, so the rule stands and the limit is recorded rather than
guessed around. `scripts/openrouter-pricing-audit.mjs` derives it
(time-independently, failing closed on any shape it does not recognise) and
diffs the whole `openrouter` block against the live API:
`pnpm run audit:openrouter-pricing`. Run it when adding or re-pricing a row.
It is deliberately NOT part of `lint:ci` — the fact lives upstream and
OpenRouter re-prices roughly weekly, so a network gate would fail PRs for
reasons outside them, and skipping it on a network error would be exactly the
silent degradation this repo forbids. What IS in the required Static lane is
`scripts/__tests__/openrouter-pricing-audit.test.mjs`, which pins the
derivation offline against real payload shapes — including the same surge
payload captured at a peak and an off-peak moment, which must yield the same
answer.
