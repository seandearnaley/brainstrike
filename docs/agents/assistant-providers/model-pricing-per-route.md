# Per-route model pricing — evidence

Supports `docs/agents/assistant-providers.md` § "Model pricing is per-ROUTE, not per-model". The Sol divergence and what BST-1705 settled about it.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1165-1211); append rather than
rewrite.

---

Each row's `pricing` is declared from the source that BILLS that route: a
first-party `openai` row from developers.openai.com, an `openrouter/*` row
from OpenRouter's live Models API (`https://openrouter.ai/api/v1/models`,
whose per-token decimal strings are x 1e6 to reach $/MTok). Two rows for the
same underlying model may therefore carry DIFFERENT rates, and a divergence
between a direct row and its OpenRouter twin is EXPECTED DATA, not drift —
do not "fix" one row to match the other.

The live instance: `gpt-5.6-sol` is 4/20 $/MTok on the `openai` row and 2/10
on `openai/gpt-5.6-sol` (both retrieved 2026-09-08). The divergence is
Sol-specific, and the evidence for that is LIVE-vs-LIVE, not our own rows: on
2026-09-09 the OpenRouter Models API and developers.openai.com agree exactly
on every sibling checked — terra 2/12, luna 0.2/1.2, gpt-5.5 5/30,
gpt-6-astra 10/50 — so OpenRouter is a faithful pass-through and only Sol
(2/10 vs 4/20) departs. Do NOT argue this from two catalog rows agreeing with
each other: the `openai` block's terra, luna and gpt-5.5 rows are stale and
agree only because they were copied from one stale source (BST-1705 re-priced
the `openrouter` block; the direct `openai` rows still carry the old figures
and need their own pass against developers.openai.com).
It is recorded rather than resolved: OpenRouter is the route that bills the
user, provider-reported billed cost stays authoritative at runtime, and a
declared rate is a display estimate.
`packages/assistant-contract/src/__tests__/provider-registry-pricing.test.ts`
pins both rows AND asserts they differ, so a sweep that mirrors them fails.

**What BST-1705 settled about Sol, and what it did NOT.** SETTLED: the 4/15
figure that sits beside OpenRouter's 2/10 is a declared `min_prompt_tokens:
272000` LONG-CONTEXT TIER in the route's `pricing.overrides` — not a
time-of-day surge band, and not an anomaly. 2/10 is what the route charges an
ordinary prompt and 4/15 is what it charges above 272K input tokens; our
one-rate-pair schema carries the base and drops the tier (BST-1708 owns
modelling tiers), so 2/10 is the right number to hold for THIS route under
the per-ROUTE rule above.

NOT SETTLED, and do not read this section as if it were: **why the gateway
says 2/10 where developers.openai.com says 4/20**. The tier explains what
4/15 IS; it does not reconcile that gap, which is the thing the older caveat
flagged. The tier arguably makes the alternative reading STRONGER, not
weaker — OpenRouter's long-context input rate is 4 and the direct row's
disputed figure is 4/20, which is as consistent with "the direct Sol row was
read off OpenAI's >=272K tier" as with "Sol genuinely diverges". So the row
`_note` on `openrouter/openai/gpt-5.6-sol` still says the divergence MAY be
an upstream data error, and that stands: re-read both sources during the
`openai`-block pass (the same pass that owes terra, luna and gpt-5.5 their
own re-pricing) rather than treating either row as settled here. What the
pin in `provider-registry-pricing.test.ts` asserts is only that the two rows
DIFFER and are sourced separately — not that 2/10-vs-4/20 has been explained.

---

## 2026-09-23 — BST-1804 re-read of both Sol routes and the direct `openai` pass

This is the `openai`-block pass the section above deferred to.

**Sol, re-read at both sources.** developers.openai.com (model page and the
pricing page's "Cyber models" table) publishes `gpt-5.6-sol` at 4/20 $/MTok
short-context and **8/30 above 272K input tokens** (2x input, 1.5x output),
still marked as promotional pricing "available at least through November 21,
2026". OpenRouter's Models API publishes `openai/gpt-5.6-sol` at 2/10 with a
`min_prompt_tokens: 272000` tier at 4/15. That settles the alternative reading
recorded above: the direct row was NOT read off OpenAI's long-context tier,
because that tier is 8/30, not 4/20. Both rows are what their own source
publishes today, so neither changes. The gap itself is still unexplained:
every OpenRouter Sol figure (both tiers, both cache rates) is exactly half of
OpenAI's. It is kept as per-route data, and provider-reported billed cost stays
authoritative at runtime. One more observation, recorded without a conclusion:
OpenRouter's Sol payload is identical, field for field, to OpenAI's rates for the
newly released `gpt-6-sol` (2/10, 4/15 above 272K, cache 0.2/2.5). OpenRouter
already published 2/10 with the 4/15 tier on 2026-09-08, two weeks before
`gpt-6-sol` shipped, so this match does not show that one was copied from the
other.
`provider-registry-pricing.test.ts` keeps its assertion that the two rows
differ, because both sources still say they do.

**Direct `openai` rows re-priced.** Every row was read from
`https://developers.openai.com/api/docs/models/<id>` (standard short-context
rate). Where a row appears in the pricing page's tables, it agrees
(`gpt-5.3-codex` 1.75/14). Eleven rows were stale:
terra 2.5/15 → 2/12, luna 1/6 → 0.2/1.2, gpt-5.5 1.25/10 → 5/30, gpt-5.5-pro
15/120 → 30/180, gpt-5.4 1.25/10 → 2.5/15, gpt-5.4-pro 15/120 → 30/180,
gpt-5.4-mini 0.25/2 → 0.75/4.5, gpt-5.4-nano 0.05/0.4 → 0.2/1.25,
gpt-5.3-codex and gpt-5.2 1.25/10 → 1.75/14, and gpt-5.2-pro 15/120 → 21/168.
Four also had the wrong `contextWindow`: gpt-5.5, gpt-5.5-pro, gpt-5.4 and
gpt-5.4-pro are 1,050,000, not 400,000. `maxOutputTokens` (128,000) matched on
every row. `gpt-6-astra` and `gpt-5.6-sol` already matched.
After the pass, the direct and OpenRouter rows agree on terra, luna, gpt-5.5 and
gpt-5.4. The live-vs-live check from 2026-09-09 had predicted that result.

**Follow-up drift, same day.** The direct `google` default `gemini-3.5-flash`
held 0.3/2.5, which is Gemini 3.5 Flash-Lite's rate. ai.google.dev's pricing
page lists model code `gemini-3.5-flash` at a flat 1.50/9.00 on the Standard
paid tier, with no prompt-size tier (only 3.1 Pro has a >200k tier there). The
model page confirms the 1,048,576/65,536 limits already on the row.

**OpenRouter context windows, 2026-09-23.** `z-ai/glm-5.3` listed a model-level
`context_length` of 1,310,720, which only Cloudflare served, against a
`top_provider.context_length` of 1,048,576 that nearly every other endpoint
matched. An earlier commit on the branch had raised the row to 1,310,720; it was
reverted to 1,048,576, because `contextWindow` drives the context meter and the
compaction limit, and a prompt in the gap would fail on most providers before
compaction ran. Review then found three more rows reading the model-level field,
each pairing one provider's window with another provider's max output:
`nvidia/nemotron-3-ultra-550b-a55b` (262,144 from DeepInfra alone, which caps
output at 16,384; top provider BaseTen 202,800 / 182,520),
`thinkingmachines/inkling-small` (1,048,576 from BaseTen alone, output 32,768;
top provider DeepInfra 524,288 / 262,144) and `deepseek/deepseek-v4-flash-0731`
(1,310,720 from Cloudflare alone; top provider 1,048,576 / 943,718). All three
were set to the `top_provider` pair, and the rule moved into the contract. The
live metadata reader (`openrouter-model-metadata.ts`) still installs the
model-level field.
