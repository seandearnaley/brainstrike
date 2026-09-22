# Compaction trigger and prune-first mechanics — evidence

Supports `docs/agents/assistant-persistence.md` §
"Trigger and prune-first mechanics". Read this before proposing to change where the pass runs, the denominator, or the prune-first sequence.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`initializeAgentStream` runs the compaction capability after the
`UserPromptSubmit` gate has proceeded and before `resolveInitialAgentStream`
constructs the real user turn. The denominator is resolved for the selected
provider/model from the static catalog as
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)`; a runtime-
discovered model may use only the already-resolved positive
`agentLoop.inputTokenLimit`, never a guessed window. The numerator walks the
current tombstone-filtered durable messages plus request messages not yet
persisted and applies active compaction ranges with
`filterMessagesByCompactionRanges`. The common-case first threshold estimate
walks those raw messages without materializing the deep projection clone; only
after that estimate reaches 90% does the prune-first path load Layer 1/2
rewrites, project the messages, and recompute provider-visible usage. The
counter includes text, reasoning, tool arguments/results, bounded attachment
markers, and legacy flattened string content. This server-side persisted-message
walker is a second implementation of the BST-940 renderer heuristic because
the renderer walker depends on assistant-ui message utilities; it should move
to a shared dialect-aware package if those message shapes converge.

Below `previousPromptBaseline + messageTokens < 0.90 * effectiveInputBudget`
the trigger is a strict no-op: no recency scan or write. At or above it,
desktop calls the extracted
`runRecencyPruneScan({ threadId, runtimeData })`, then re-reads both rewrite
overlays and messages and recomputes provider-visible usage. If pruning brought
usage below 90% after the same baseline is added, the turn proceeds. Otherwise
compaction commits candidates outside `selectProtectedMessageIds` and aims to
leave message-side usage at
`max(1024, 0.70 * effectiveInputBudget - previousPromptBaseline)`; protected
messages can make that target unreachable and are never sacrificed. The fixed
1024-token floor prevents deterministic pruning from erasing useful recent
state merely because baseline prompt content consumes most of a small model's
target.


