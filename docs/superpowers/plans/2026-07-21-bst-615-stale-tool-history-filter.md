# BST-615: Filter stale read/search tool history

## Decision boundary

Reduce repeated provider context without mutating durable Mastra evidence. Only
old, completed, successful read/search/retrieval invocations with a stored
`providerMetadata.mastra.modelOutput` may be filtered. Keep the two most recent
tool-producing steps and every unsafe or stateful interaction verbatim.

Mastra 1.51's stock `ToolCallFilter` is the transformation engine, but a thin
Brainstrike wrapper must decide eligibility per tool call. The stock processor
filters by tool name and its recent-step state is request-local, so using it
directly would not preserve errors or produce reload/live parity.

## Plan

1. Add red unit fixtures for an old safe read result, the two-step recent
   window, missing projections, guarded/domain errors, multimodal output,
   artifact continuation, edits, verification, discovery, and suspended calls.
2. Implement a projection-safe wrapper that clones provider-input messages,
   protects every ineligible invocation, and delegates only eligible calls to
   Mastra `ToolCallFilter({ preserveModelOutput: true })`.
3. Install it after tool discovery and before provider-history compatibility
   and `ProjectionAwareTokenLimiter` on initial, approval-resume, and
   suspending-tool-resume calls. Emit content-free filtering diagnostics.
4. Prove memory-source and live-source messages produce the same provider
   projection while the original `MessageList` remains byte-for-byte unchanged.
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
