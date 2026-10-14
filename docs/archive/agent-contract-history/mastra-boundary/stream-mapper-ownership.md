# R6 stream mapper ownership — evidence

Supports `docs/agents/mastra-boundary.md` § "R6 STREAM MAPPER OWNERSHIP". Read
this before moving anything out of `agent-streaming.ts` or adopting a Mastra
stream/route layer. The module split below (BST-985, BST-986, BST-1649) is the
record of who owns which mapping concern; line numbers are as measured then.


**Brainstrike's typed `StreamChunk` union is the UI and persistence contract.
Mastra output is adapted into it. Mastra's AI SDK UI stream and route layer is
not adopted, regardless of AI SDK version.**

The accepted baseline is AI SDK v7 provider packages (provider v4) with
`@mastra/core` 1.64. Brainstrike adopts their model/provider capabilities while
continuing to own HTTP transport, stream mapping, persistence, and UI contracts.

Two stages, and both are Brainstrike-owned:

1. Mastra chunk → `StreamChunk`: `processMastraStreamPart` in
   `packages/agent/src/mastra/agent-streaming.ts`. Its PURE decoders (part-shape
   readers, tripwire resolution/bounding, provider-error resolution, tool-event
   metadata, OM readers) live in `packages/agent/src/mastra/mastra-chunk-decoding.ts`
   and are unit-tested directly (BST-985). The impure mapping concerns the dispatch
   delegates to are one module each (BST-986), all under `packages/agent/src/mastra/`:

   | Module | Owns |
   | --- | --- |
   | `stream-run-event-chunks.ts` | run-event + finish chunk MINTING (`generateUUID` + `new Date()`); the leaf every other concern depends on |
   | `tool-lifecycle-processors.ts` | the mutable `ToolLifecycleState` record and every mapper that reads or advances it (tool events, delegation/subagent events, terminal + pending-output run events, the finish chunk) |
   | `tool-approval-chunks.ts` | `tool-call-approval` / `tool-call-suspended` PAUSES — well-formed approval, well-formed suspend (registered or not), and the malformed-pause termination |
   | `stream-termination.ts` | abnormal-ending POLICY: provider error, tripwire, stream stall, tool-call-input timeout |

   `agent-streaming.ts` keeps the R6 dispatch itself, the OM data-part mapping, and
   the public entry points — that file is pinned by name in
   `scripts/mastra-stream-chunk-contract.mjs`, so the `ChunkType` import, the
   disposition inventory, `processMastraStreamPart`, and
   `warnForUnrecognizedMastraStreamPart` must not move out of it. The tool-loop /
   stream-option builders moved to `runtime-assembly/stream-options.ts`, and the
   turn/attempt model + three attempt-leg factories moved to `turn-attempts.ts` /
   `attempt-legs.ts` (BST-1649) — none of those three modules are part of the
   pinned contract.

   Provider-error CLASSIFICATION was never part of this file: `../provider-error-metadata.ts`
   owns the bounded `runError` extractor and `mastra-chunk-decoding.ts` owns
   `resolveProviderError` / the diagnostic code + correlation. Likewise the watchdog
   MECHANISM is `../stream/with-inactivity-timeout.ts` + `../stream/with-tool-call-input-timeout.ts`;
   `stream-termination.ts` owns only what a fired watchdog emits.
2. `StreamChunk` → encoded frames: `DataStreamMapper`,
   `packages/agent/src/stream/data-stream-mapper.ts:255` (dispatch `:289-321`).

The mapper is load-bearing for three already-recorded rulings in
`docs/agents/assistant-runtime.md` that adopting Mastra's output would break:

- Run-event deferral across streaming text parts (`:302-306`) — *"never drop them,
  never emit them mid-part."*
- `shell-output` is transient **by design**, and `chunk.type === 'run-event'` is the
  **durable-persistence discriminator** decided at the mapper (`:393-400`).
- The terminal Stop hook must run **before** `message-finish` is yielded
  (`:974-981`).

Transient-vs-durable is a mapper decision. That is the contract.

