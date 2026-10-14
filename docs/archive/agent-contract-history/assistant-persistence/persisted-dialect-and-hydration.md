# Persisted dialect and hydration grouping — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the Mastra v2 dialect assumptions, the dual tool-output channel, or the snapshot-grouping rules.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Hosted-provider turns are persisted by Mastra (the durable writer) into
`mastra_messages`; the client history adapter is read-through only. Two
contracts keep reloaded threads identical to live ones:

1. **Persisted dialect (Mastra v2 / `MastraMessageContentV2`):** content is
   `{ format: 2, parts: [...] }`. Tool calls are
   `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
   state, result } }` parts with results INLINE — there are NO `role: 'tool'`
   rows in this dialect (the legacy `tool-call` part + separate tool rows is
   still supported for old data). Reasoning may arrive with a `reasoning`
   field instead of `text` (and is often empty for encrypted provider
   reasoning). `step-start` and `data-om-*` bookkeeping parts are not
   renderable. Live-loop proof (real agent + real PGlite memory, no mocks):
   packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts. Hydration
   fixtures must mirror REAL persisted rows, never hand-written shapes — a
   hand-written `tool-call` fixture previously kept tests green while real
   tool history silently vanished on every reload.
   Tool output uses a deliberate dual channel: Mastra persists
   `toolInvocation.result`, while `toModelOutput` supplies the bounded text or
   multimodal projection repeated into provider requests. Native tools keep the
   raw domain result. Approval resumes seed the live stream from Mastra's exact
   storage-backed suspended-tool snapshot before consuming resumed output. That
   preserves the original `toolInvocation.args` when the resumed provider emits
   only a terminal result; both the live completed card and this format-2 row
   therefore hydrate with the same arguments. While the approval and resume
   legs temporarily occupy separate assistant-ui messages, rendering correlates
   their non-empty arguments by the unchanged `toolCallId`; a resumed live copy
   exposing `{}` cannot replace the approved payload. Missing snapshot arguments
   abort the decision before execution instead of persisting an invented empty object.
   PostToolUse context is model-only: hook execution uses a
   discriminated internal carrier, `transform.display` unwraps it for the live
   UI, and `transform.transcript` unwraps it for storage. Mastra 1.51 attaches
   the correct transcript transform metadata but still hands its raw in-memory
   message to `MemoryStorage.saveMessages`; `PgliteMemoryStore.saveMessages`
   therefore applies that official transcript projection again at the durable
   boundary, returns the projected messages from `saveMessages`, and
   independently refuses to store or return a surviving internal carrier.
   The real-memory hook regression proves the stored invocation is the exact
   domain result while `providerMetadata.mastra.modelOutput` retains the
   model-only guidance. OpenAI hosted `tool_search` calls add a stricter
   round-trip invariant: Mastra's consolidated invocation retains the `tsc_`
   call as `toolCallId`, the distinct `tso_` output in provider metadata, and
   `providerExecuted: true`. On reload Mastra projects the result metadata onto
   both model parts, so the OpenAI-only request processor restores the call
   reference from `toolCallId` and the output reference from the persisted
   metadata at the transient provider boundary. The real PGlite integration
   proof serializes the next turn with the production OpenAI Responses model
   and requires each item reference exactly once; missing output metadata
   remains a visible error, never a call-ID fallback. MCP results remain inline
   only within the explicit temporary persistence ceilings documented in
   `assistant-providers.md`; text-only MCP output is preview-bounded until
   artifact settlement is wired. Never replace a native result inside
   `execute()` merely to save prompt tokens; that destroys
   reload/application evidence. The real-memory proof includes an oversized
   native sentinel and replays a second turn from the same thread in
   `packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`;
   it also reconstructs a fresh hosted runtime over three stored native reads
   and proves that transient stale-history filtering removes only the oldest
   provider-facing call scaffolding while all three raw database rows remain.
   the live-provider proofs that raw sentinels are absent and MCP image/audio
   remain model-native live in `mastra-tool-execution.integration.spec.ts`.

2. **Snapshot grouping + live-order interleaving:** observational-memory
   sealing and per-step saves split ONE live assistant turn into several
   `mastra_messages` rows (progressive snapshots under fresh ids, so one
   toolCallId can appear in several rows). Hydration
   (packages/assistant-data/src/assistant-memory-repository.ts) therefore:
   - merges consecutive assistant rows into ONE assistant-ui message (id =
     last row, createdAt = first row; legacy `role: 'tool'` rows don't split
     a group),
   - dedupes tool calls by toolCallId (first occurrence wins; later
     result/error fields merge in),
   - recalls the latest 80 message rows together with events from the latest
     80 runs, partitions events by `runId`, assigns each run to the assistant
     turn inside that run's time window, and weaves them between content parts
     in time order. Never attach only the newest run to the newest message:
     older turns would lose tool failure state, timings, and subagent activity
     after reload. Tool-invocation parts carry no persisted timestamp, so each
     is re-timed to its `tool.started` run event (matched via
     `metadata.toolCallId`); other untimed parts anchor to their snapshot row's
     save time. Equal-timestamp rows use Mastra's per-part `createdAt` values
     before the row role/id fallback. A group with only run events still
     renders.
   - recognizes guarded tool results with the canonical
     `@brainstrike/assistant-contract` type guard. A known guarded result
     (`ok:false`) hydrates as a failed tool call even though Mastra persists
     the invocation itself with `state:'result'`; the execution and replay
     paths must never maintain independent guarded-error code lists.


