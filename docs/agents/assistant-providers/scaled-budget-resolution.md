# Scaled budget resolution — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". How the per-run budget resolves, the anchor arithmetic, override scaling, and replay asymmetry.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4242-4332); append rather than
rewrite.

---

`createMastraAgentRuntime` resolves the active model once in
`packages/agent/src/mastra/agent-runtime.ts` via `resolveToolResultBudgetForModel`,
which reads the catalog `contextWindow` (`findLlmModelDefinition`, non-throwing)
and calls `resolveScaledToolResultBudget`. A budget default is NEVER a hard
precondition for starting a run: `getLlmModelDefinition`'s throwing form is not
used here, because the static registry is a curated subset (OpenRouter
metadata-only/auto-profile models, and persisted preferences from a retired
catalog entry, are routinely absent from it) and a budget lookup failing must
never kill a run. Runtime-discovered Ollama and LM Studio ids use the shared
conservative 32,768-token declaration from `@brainstrike/assistant-contract`
(`DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW`); every OTHER unknown provider/model id
falls back to the 131,072-token ANCHOR — the exact pre-BST-1206 fixed-budget
behavior — with a visible `tool_result_budget_unknown_model_fallback` warn log
(not a silent fallback: the documented default, logged). A genuine registry
misconfiguration (a registered entry with an invalid `contextWindow`) still
throws through `resolveScaledToolResultBudget`'s own validation rather than
being swallowed as "unknown model". The plain resolved carrier is threaded
through MCP inline bounding, the core and deferred discovery surfaces, persona
projections, and `RunTokenDiagnostics`. The sole module-scoped context is the
save/restore `activeToolResultBudget` around one synchronous custom-projector
call: it is not run state, is never held across a Promise, and exists because
Mastra's `toModelOutput(output)` signature cannot carry the per-call budget
when a persona re-projects a parent-owned tool object.

BST-1219 (done; follow-up to PR #2349) closes the producer/guard seam for fresh
desktop projections. `packages/assistant-service/src/stream-init.ts` normalizes
the trusted provider, applies the same default-model fallback, resolves the
budget before `capabilities.tools.build`, and carries it in
`AgentStreamToolDependencies.resolvedToolResultBudget`.
`buildDesktopAssistantTools` captures its domain-character value in every
purpose-built projector only as a fallback for direct callers and in
`readWorkspaceFile`'s page fitter. Wrapped parent/persona projection calls read
the active resolved carrier synchronously, so the SAME desktop tool object can
narrow or widen for a pinned child's own budget. `readToolOutputArtifact` uses
that seam too; its page and search projectors self-fit against the passed
domain budget instead of the fixed 6000-character anchor. The later
Mastra runtime independently resolves the same provider/model pair once for
its guard and transport pipeline; `stream-init-tool-budget.test.ts` pins parity
between those two resolutions. Invalid providers remain a visible anchor
fallback at the earlier construction seam and still fail normally at runtime
configuration; an unknown model retains the resolver's single documented warn.

The anchor is 131,072 context tokens. Defaults scale linearly and round to the
nearest token: domain is `round(1500 * contextWindow / 131072)` clamped to
500..3000 tokens (2000..12000 characters), while transport is
`round(3000 * contextWindow / 131072)` clamped to 1000..6000 tokens
(4000..24000 characters). Thus a 128k model retains byte-identical 1500/3000
behavior and no model exceeds the settled 2x small-page ceiling. Domain-level
per-tool entries in `MODEL_PROJECTION_BUDGET_OVERRIDES`
(`packages/agent/src/mastra/tool-model-output.ts` — `executeCommand`, `skill`,
`runPython`, and the rest of the `NATIVE_SELF_BOUND_*`/`SKILL_ACTIVATION_*`
group) stay fixed, unscaled, at every tier — they key off their OWN dedicated
constants (`NATIVE_TOOL_RESULT_TOKEN_BUDGET`, `SKILL_ACTIVATION_RESULT_TOKEN_BUDGET`),
not the domain/transport pair this section scales, and are out of BST-1206's
scope.

Transport-level per-tool entries in `TOOL_RESULT_TOKEN_BUDGET_OVERRIDES`
(`packages/agent/src/stream/tool-output-limits.ts` — currently just `skill:
6000`) are DIFFERENT: an override authored against an implicit 128k assumption
is not really an explicit per-model decision, and on an 8192-token Gemma run
the fixed 6000-token `skill` override alone is ~73% of the entire context for
one activation. So these overrides scale WITH the resolved transport budget —
but only DOWN, never up: at or above the anchor (the resolved transport budget
`>= MAX_TOOL_RESULT_TOKENS`), an override wins unchanged (overrides are
ceilings authored deliberately, never inflated past what their author chose).
Below the anchor, an override scales by the SAME factor as the generic
default — `round(override * resolvedTransportTokens / MAX_TOOL_RESULT_TOKENS)`
— floored at the generic 1000-token transport floor so no override collapses
to something unusably tiny. `resolveOverrideTokens` in `tool-output-limits.ts`
implements this; `boundToolOutputForModel`'s `scaledDefaultTokens` param is the
resolved value used for both the generic fallback and this override scaling.

Replay validation is deliberately asymmetric. A fresh purpose-built projection
uses the current run's resolved default. A stored/settled projection may have
been produced by a larger-window run, so replay always validates the default
domain portion against the fixed ceiling tier (3000 tokens / 12000 characters),
never the possibly smaller current run value. The out-of-scope total model
envelope (`MAX_MODEL_TOOL_RESULT_TOKENS` / `MAX_MODEL_TOOL_RESULT_CHAR_BUDGET`,
2000 tokens / 8000 characters) and every domain-level `MODEL_PROJECTION_BUDGET_OVERRIDES`
entry remain unchanged at every tier, on both fresh and replayed projections.
Because that total envelope never scales, replay's newly-composed hook context
(`composeHookContextWithProjection`) is fitted against the SAME fixed
8000-character ceiling whether the stored domain payload came from a
huge-window run or the current run's own resolved tier — a known, documented
tradeoff, not yet fixed; see `docs/agents/assistant-runtime.md`'s replay
section for the full reasoning. BST-1219 widened budget context only for FRESH
desktop producers; the replay hook-context/total-envelope tradeoff remains a
separate deferred follow-up and was not changed.
The file-read staleness tracker is updated only after cursor validation and
page construction succeed inside the per-file lock; a rejected stale cursor
must not mark externally changed bytes as fresh for a later write.
