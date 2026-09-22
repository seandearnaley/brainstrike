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
