# BST-615: Filter stale read/search tool history

## Decision boundary

Reduce repeated provider context without mutating durable Mastra evidence. Only
old, completed, successful read/search/retrieval invocations with a stored
`providerMetadata.mastra.modelOutput` may be filtered. Keep the two most recent
tool-producing steps and every unsafe or stateful interaction verbatim.

Mastra 1.51's stock `ToolCallFilter` establishes the replacement semantics, but
Brainstrike must implement them at `processLLMRequest`. The stock processor
filters by tool name and returns messages from `processInputStep`; Mastra then
applies those messages to the live `MessageList`, which can erase raw same-turn
evidence before persistence. A Brainstrike processor must decide eligibility
per call without mutation and rewrite only the transient provider prompt.

## Plan

1. Add red unit fixtures for an old safe read result, the two-step recent
   window, missing projections, guarded/domain errors, multimodal output,
   artifact continuation, edits, verification, discovery, and suspended calls.
2. Implement a projection-safe processor that records eligible calls without
   mutating `processInputStep` messages, then replaces matching call/result
   pairs only in the transient `processLLMRequest` prompt.
3. Install it after tool discovery and before provider-history compatibility
   and `ProjectionAwareTokenLimiter` on initial, approval-resume, and
   suspending-tool-resume calls. Emit content-free filtering diagnostics.
4. Prove memory-source and live-source messages produce the same provider
   projection while the original `MessageList` remains byte-for-byte unchanged,
   including three calls performed and persisted inside one hosted turn.
5. Update the runtime/provider/persistence contracts, run focused tests and
   multi-provider Electron/CDT long-thread checks, then run the full root gate
   once before publishing the PR.

## Scope guards

- No persisted-row deletion, compaction-policy change, or UI-history rewrite.
- No filtering of edits, command execution, approvals/declines, errors,
  verification/plan/task state, discovery controls, incomplete calls, or MCP
  tools.
- No provider-specific fallback and no local/Gemma routing change.
- No generic summarization or programmatic tool-calling work.
