# Foreground query coordination on the hidden host — evidence

Supports `docs/agents/local-inference.md` § "Foreground query coordination".
Read before changing the gate, the drain, or the wiring between them.

CORRECTION (verified 2026-09-21): the original text named a constant
`FOREGROUND_GATE_REOPEN_MS`. No such identifier exists in the codebase; the
250 ms reopen delay is `DEFAULT_REOPEN_DELAY_MS` in
`packages/embeddings/src/worker/foreground-embedding-gate.ts`, overridable per
gate through `reopenDelayMs`. `QUERY_DRAIN_TIMEOUT_MS = 5000` is real, in
`apps/desktop/src/renderer/components/embedding-host-runtime.tsx`. The phantom
name is itself a recorded incident: see the comment in
`packages/assistant-contract/src/__tests__/personas.test.ts`, where an agent
read it out of this document and reported it as a code constant.

## Original text

Foreground query coordination (desktop):
- The hidden host runs BOTH background indexing and assistant query embeddings; a
  foreground query must never share the GPU with background indexing.
- `createForegroundEmbeddingGate()` (packages/embeddings/src/worker/foreground-embedding-gate.ts),
  exposed via `@brainstrike/embeddings/worker`:
  - The worker's `waitForBackgroundPermit('embedding claim')` awaits the gate, so no NEW
    indexing batch starts while a query is in flight. Only the *claim* permit is gated
    (never completion) — this keeps draining deadlock-free.
  - The query handler drains the in-flight batch via `waitForWorkerIdle` (waits for the
    worker `active` flag, which is true only during inference) before generating, via
    `runCoordinatedQueryEmbedding`.
- The pure foreground-gate suite controls polling and reopen time with fake timers,
  restores timer state after every case, and checks release on success, failure and
  drain timeout. Never substitute a wall-clock sleep for a debounce assertion.
- Wiring: `embedding-worker-config.ts` (`composeClaimPermit`) +
  `embedding-host-runtime.tsx` (gate per runtime, threaded to the worker config + query
  handler). Constants: FOREGROUND_GATE_REOPEN_MS (250), QUERY_DRAIN_TIMEOUT_MS (5000).
- Foreground DB-pressure permits age scheduler quiet/latency windows from the
  scheduler's monotonic snapshot timestamps (the timestamp pair shares one
  clock origin even when snapshots cross IPC). The embedding claim path's
  bounded starvation bypass uses `performance.now()` in the hidden renderer.
  Wall-clock corrections must not extend either wait.
