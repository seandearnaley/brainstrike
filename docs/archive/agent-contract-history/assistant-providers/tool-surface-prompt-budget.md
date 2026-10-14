# Tool surface prompt budgets — evidence

Supports `docs/agents/assistant-providers.md` § "Programmatic orchestration decision". The measured prompt-budget bands and what each one is counting.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5508-5568); append rather than
rewrite.

---

The live assembly order is pinned by `TOOL_DISCOVERY_PIPELINE_ORDER`:
capability/permission eligibility → guards/hooks → plan/permission/suspend gates
→ provider-native web-search swap → output settlement/projection → skills
metadata → discovery → projection-safe stale-history filtering →
provider-history compatibility → projection-aware token limiting. Initial,
approval-resume, and suspend-resume
calls all use the same per-runtime processors in the per-call input stack:
SkillsProcessor → tool search → ProjectionSafeToolCallFilter →
ToolProjectionRewrite → ProviderHistoryCompat → OpenAI tool-search history
compatibility → OpenAI duplicate-item compatibility →
ProjectionAwareTokenLimiter. Token limiting remains last so it counts injected
skills metadata, loaded definitions, filtered/rewritten tool history, and
normalized provider history. Public direct stream processor overrides stay
rejected.

The full hosted desktop tool surface has two measured prompt budgets:
`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
builds the real registry and resolved hosted instructions with the default
skills engine enabled. That means both guards include `skill`, `skill_read`,
and `skill_search`, the conditional skills guidance, and a representative
first-turn `SkillsProcessor` metadata block. The canonical authored
representation converts the real Zod inputs through the Standard Schema input
protocol and must stay INSIDE the 10,096-10,396 `o200k_base` band (BST-927/
BST-980): the ceiling bounds growth, and the floor detects a tool or schema
silently falling out of the registry. These are existing test thresholds, not
bands recentered by the audit. At the 2026-09-04 measurement, authored and critical
surfaces have only 34 and 21 tokens of remaining headroom. Keeping those ceilings
is deliberate pending BST-1633's measured reductions; the audit does not promise
150 tokens of current headroom or silently raise limits to absorb drift. When
the ceiling fires, trim before raising; move both bounds
together (the ~300-token width is the contract) and record the trade in the
test's comment ledger. The live actual Mastra/OpenRouter core surface and
resolved instructions must stay between 2,000 and 5,000 tokens, materially
below the retired 11,500-token eager boundary. A real
Mastra-loop capture separately proves the first provider request contains that
core plus `search_tools`, `load_tool`, and `list_available_tools`, and that a later request appends the
definition loaded by `load_tool`. Dynamically loaded definitions are append-only within the active
context and counted by the last-position token limiter.

Both count schemas and instructions for their declared surfaces, not descriptions
alone. The core envelope excludes processor-added discovery controls. The
2026-09-04 probe measured 4,730 tokens before those controls and 5,081 with them
in the same normalized representation. BST-1633 tracks the complete post-processor
provider budget and total tokens per successful task; the existing core ceiling
must not be presented as a cap on the full request. Tokenizer counts are not
provider-billed usage or a cache-discount estimate.
Recover budget by removing duplicated prose and preserving one canonical
definition. Do not weaken validation constraints, spoof provider/model
identity, or remove cross-tool safety/workspace invariants to make either
number pass. Changing Mastra compatibility behavior requires a supported
upstream contract plus captured-request tests proving omitted optionals and
invalid/null inputs retain their authored semantics.

The same fixture also pins the authored definition-only comparison for this
contract: the eager baseline is 39 tools, measured at 9,490 `o200k_base` tokens
on 2026-09-04, within its 9,340-9,640 band. The live critical definition surface
is 8 tools, measured at 2,295 tokens within its 2,016-2,316 band, before discovery
controls are added. Counts stay exact to catch missing tools; no budget was
raised during the BST-1630 audit. System instructions, provider conversion,
skills metadata, and each dynamically loaded definition remain part of the
captured-request and last-position limiter budgets.
