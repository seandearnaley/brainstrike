# Context-overflow recovery scope — evidence

Supports `docs/agents/assistant-persistence.md` §
"Context-overflow recovery scope". Read this before proposing to change the recovery callback, the no-retry ruling, or the renderer card seam.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

The live Mastra `'error'` part checks only the stable
`context_length_exceeded`, `max_tokens_exceeded`, and
`token_limit_exceeded` codes. Before `makeProviderErrorTermination`, it awaits
the desktop recovery callback, which makes no model call, drops the oldest
eligible provider-visible messages until the 70% target is met (or all
eligible messages are exhausted), saves the deterministic summary message,
and commits `recordCompactionRange(kind: 'deterministic')`. Its visible text
and `droppedSummaryLine` are the same literal count/date-range index and state
that no summarization model ran. The terminal error then tells the user that
deterministic compaction was applied and to resend or continue.

Milestone 2 does **not** retry the same turn automatically. There is no outer
retry owner above `streamMastraAgent` / `createStreamIteratorFromRuntime`; a
safe implementation needs a separate bounded wrapper that cannot overlap
Mastra's `StreamErrorRetryProcessor`, cannot loop on deterministic overflow,
and leaves every non-overflow error terminal. Until that architecture is
implemented, recovery creates headroom only for the next request.

The renderer seam closes in `packages/assistant-ui/src/assistant-ui-panel.tsx`:
`AssistantMessage` recognizes the strict durable marker before its ordinary
bubble path and mounts `CompactionSummaryCard` from
`compaction-summary-card.tsx`. Desktop coverage lives in
`apps/desktop/e2e/assistant-compaction.desktop.test.ts`; its fixed format-2
history fixture verifies both the visible divider and a normal follow-up turn
in the same thread, then the complete summary after a second reload. Select the
hydrated target thread before configuring its mock provider. The captured
memory-backed POST contains only the new user turn plus the exact durable thread
ID and `mastra-memory-current-turn` metadata; it must not replay the summary.
This test uses a mocked assistant endpoint: it proves the real renderer transport,
shared divider and durable reload behavior, not a native Mastra recall/model run.

