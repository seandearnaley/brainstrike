# Context meter derivation and display — evidence

Supports `docs/agents/assistant-persistence.md` §
"CONTEXT USAGE METER (TOKEN AWARENESS)". Read this before proposing to change the one-derivation rule, the estimator, or the prompt-breakdown channel.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

One derivation feeds three consumers per request — keep them consistent:
`buildAgentLoopSettings(prefs, selectedModelBudgetDef)` in packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts
produces `agentLoopSettings.inputTokenLimit` (explicit user pref wins, else
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)` from
packages/assistant-contract/src/context-budget.ts — throws, never clamps). That ONE number is:
1. the Mastra `TokenLimiter` budget (`runtimeData.agentLoop.inputTokenLimit` → `buildToolLoopOptions`),
2. the meter denominator (`effectiveInputBudget` prop on `AssistantUiPanel`),
3. the instruction budget note (`buildContextBudgetNote`, appended per-request at Agent construction).

Runtime invariants:
- Usage store (packages/assistant-ui/src/context-usage-store.ts) is session-lived, NOT
  persisted; key = `selectedMemoryThreadId ?? 'active'` — the writer (`handleUsage` in the app-shell
  wrapper) and the reader (`ContextUsageMeter`, via the panel's `threadKey` prop) MUST use the same key.
- Both turn paths report usage: hosted via the data-stream `message-finish` tap
  (`onUsage` in data-stream-runtime.ts), local via the llm-host result (`onUsage` in
  local-runtime-adapter.ts; `LocalLlmGenerationResult.usage` is optional at the IPC boundary — guard it).
- Hosted multi-step finishes carry two distinct token views. Aggregate
  `inputTokens`/`outputTokens` remain the durable billing and cost totals across
  every provider step. `contextInputTokens`/`contextOutputTokens` carry only the
  latest provider step and feed the transient context meter. A transport that
  structurally has no per-step fields uses its aggregate single-step values.
  Never display a billed cross-step sum as context occupancy.
- The meter shows estimated (the FULL-PART conversation walk, see below) until exact usage lands;
  provenance must never lie — wire-format usage is
  `{inputTokens, outputTokens, contextInputTokens?, contextOutputTokens?, billedCostUsd?}`
  (e2e mocks must use the token field names).
- Estimator v2 (BST-940, `packages/assistant-ui/src/context-estimate.ts`):
  `estimateConversationTokens` walks EVERY message part — text, reasoning, tool args + results
  (per-tool attribution), attachment counts — with the shared chars/4 heuristic, memoized per
  settled message object in a WeakMap. The v1 text-only walk read coding threads absurdly low
  (tool output is ~90% of context) — never regress to a text-only walk. Heuristic accuracy is
  pinned against the REAL o200k tokenizer in
  `packages/tokenization/src/__tests__/token-counting-heuristic-accuracy.test.ts` (code ≈ +4%,
  tool JSON ≈ −22%, repetitive prose ≤ +45%).
- Display selection is `resolveDisplayedContextUsage` (same module): idle+exact → exact; while a
  run streams → LIVE estimate (server breakdown baseline: system + task list + tool definitions,
  plus the conversation walk), floored at the last exact figure (context never shrinks mid-run) and
  flagged `est.`; before any exact usage → the estimate alone. `ThreadContextMeter` re-walks on
  every message snapshot so the gauge moves during streaming.
- UI shape: a compact ring row (`context-ring.tsx` donut + used/budget fraction) that triggers the
  "Context Usage" popover (`context-usage-popover.tsx` — Cursor-style anatomy: "% full" header, a
  segmented capacity bar over the effective input budget whose segments derive from the SAME
  figures as the color-keyed legend rows [System instructions / Tool definitions / Task list /
  Conversation / Attachments / Unattributed], per-tool top-5 sub-rows with an aggregated
  remainder, a conversation split [You / Assistant / Reasoning / Tool activity + per-tool], OM
  stats, and cumulative+cost).
  The critical (≥90%) trimming-risk notice renders INLINE next to the ring, never inside the hover
  popover — a warning must not hide behind hover or claim that compaction already happened. The
  ONE-DERIVATION invariant above is unchanged:
  `agentLoopSettings.inputTokenLimit` remains the TokenLimiter budget, the meter/ring denominator,
  and the instruction budget note; the popover introduces no second derivation.
- Prompt breakdown channel: the agent computes category counts at prompt
  assembly (`packages/agent/src/mastra/prompt-breakdown.ts` — instruction-side at Agent
  construction, message-side at stream start; tool-definition totals + per-tool figures come from
  the run's `RunTokenDiagnostics.toolDefinitionContextBreakdown()`, tokenizer-measured when the
  o200k counter loads, chars/4 backstop otherwise — breakdown `provenance` is
  `'measured' | 'heuristic'` accordingly, and every displayed figure keeps its "~") and emits
  them once per initial turn as the
  TRANSIENT `brainstrike.context-breakdown` aui-data part
  (`@brainstrike/assistant-contract/context-breakdown`), honoring the same text-part deferral
  contract as run events / shell output. NOT a run-event ON PURPOSE (shell-output precedent): the
  desktop run-event persistence tap passes non-run-event chunks through, so the breakdown is never
  persisted — after reload the popover honestly has none until the next run. Non-measurable
  categories are ABSENT fields, never zero-faked (memory-backed runs omit `historyMessagesTokens`
  because the wire carries only the current turn; the popover falls back to the client heuristic
  walk). The renderer tap (`onContextBreakdown` in the ui data-stream runtime → app-shell
  `handleContextBreakdown`) parses via the contract guard — malformed wire payload →
  `{ invalid: true }`, stored and SURFACED in the popover, never coerced — and records into
  `breakdownByThread` on the same session-only usage store under the same thread-key contract as
  `recordUsage`. The "Unattributed" row is display math only (exact `inputTokens` − displayed
  categories, clamped ≥ 0 with a debug log) and appears only once exact usage lands. The
  in-renderer local runtime path has no breakdown channel (capability-absent — web
  `LocalRuntimeChat` unaffected). The data part is registered with a null renderer in
  `AssistantDataRendererRegistration` (assistant-ui-panel.tsx, mirroring `SHELL_OUTPUT_DATA_NAME`)
  so the transient part never surfaces as a stray element in the message flow — it is consumed only
  by the `onContextBreakdown` tap, never rendered inline. Because a capability-absent local turn
  can never refresh the breakdown, `handleUsage` clears the thread's stale breakdown
  (`useContextUsageStore.getState().clearBreakdown`) whenever `hasContextBreakdownChannel`
  (assistant-ui-panel-wrapper-runtime.ts) is false for the active provider/transport pair —
  otherwise a later local turn on a thread that previously had a hosted turn would update exact
  usage while the popover kept showing the earlier hosted turn's stale category rows.
- OpenRouter finish messages must additionally carry `billedCostUsd`, sourced
  from Mastra's official OpenRouter provider metadata. Persist it in
  `brainstrike_assistant_run_usage.billed_cost_usd`; cumulative and cross-root
  views use the provider amount for reported rows and registry pricing only for
  legacy/unreported rows. Mixed groups add both portions and retain estimated
  provenance; entirely provider-reported groups use `provider-reported`.
  Approval/suspension pauses emit a zero-token finish without cost because
  Mastra emits the pause before exposing that model step's `step-finish`. On
  resume, Mastra emits the deferred pre-pause step finish and all subsequent
  steps; the normal terminal usage tap persists their exact aggregate once.
  MISSING cost metadata on a new OpenRouter completion records the cost as
  UNKNOWN — the field is omitted, `billed_cost_usd` stores null, and the row
  falls through to registry-priced/estimated provenance — with a visible
  `provider_billed_cost_unreported` warning. It is never mislabeled as an exact
  or zero-cost run, which is what the previous fail-visibly rule protected, and
  it no longer destroys the completed turn: OpenRouter reports no cost at all
  for anonymous/stealth routes (`stealth/ox-alpha`, migration 107), so the old
  rule failed every one of those turns at the finish. MALFORMED metadata is
  loud but equally non-fatal: it records unknown too, with
  `provider_billed_cost_malformed` logged at ERROR rather than a throw, because
  binning a finished answer over a telemetry field is the same bad trade
  whatever the shape of the bad value. Absent is a fact about the route;
  malformed is a broken contract someone should fix. Neither is ever recorded
  as zero.

