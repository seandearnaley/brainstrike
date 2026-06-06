# Embedding-Host Query/Indexing Coordination — Design

- **Date:** 2026-06-05
- **Workstream:** #2 of 5 in the assistant-hardening decomposition (indexer ↔ query coordination)
- **Scope:** Desktop hidden embedding-host only (per decision). Web visible-renderer path is a possible follow-up.
- **Strategy:** Pause-and-drain (per decision).
- **Status:** Approved approach + scope; pending spec review.

## Problem

On desktop, both the background embedding **indexer** and the assistant's per-query
**embedding generation** run in the hidden embedding-host renderer, each on its own
`SimpleEmbeddingService` with **no coordination on the GPU/WebGPU device**. When the
assistant requests a query embedding while indexing is mid-inference, both hit WebGPU
concurrently → the failure the user observed ("both can't happen at once → error"), plus
WebGPU buffer pressure that is only released by restarting the renderer.

The **DB layer is already coordinated** — a `DatabaseWorkScheduler` +
`DatabasePressureController` make the background worker yield DB claims to foreground work
(`packages/db/src/database-{work-scheduler,pressure-controller}.ts`). The gap is purely the
**GPU/model**: a query embedding is pure GPU work that does not register as DB pressure, so
nothing currently stops the indexer's GPU inference during a query.

## Key facts (verified in code)

- The worker yields at `await waitForBackgroundPermit('embedding claim')` **before** claiming
  a batch ([embedding-worker.ts:1374](../../../packages/embeddings/src/worker/embedding-worker.ts)),
  and at `'embedding completion'` before writing results (line 892).
- Inference runs between claim and completion, wrapped by `beginActiveBatch()`/
  `endActiveBatch()` (lines 1394-1398), which drive `onWorkerActivityChange(active)`
  (lines 178-194). So `active === true` **only during inference**.
- The host wires `waitForBackgroundPermit` from `createEmbeddingWorkerConfig(db)`
  ([embedding-worker-config.ts:126](../../../apps/desktop/src/renderer/components/embedding-worker-config.ts))
  → `pressureController.waitForBackgroundPermit`.
- The host tracks worker activity in `activeRef` via `createActivityChangeHandler`
  ([embedding-host-runtime.tsx:388](../../../apps/desktop/src/renderer/components/embedding-host-runtime.tsx))
  and handles query embeddings in `handleQueryEmbeddingRequest` (line 338), which already
  caches the query embedder by `modelKey` (`getQueryEmbeddingService`, lines 312-336).

## Design

Pause-and-drain, composed on the existing seams. Two guarantees:
- **No new batch starts during a query** — gate the *claim* permit on "foreground query in
  progress".
- **The in-flight batch is drained first** — wait for `active === false` before running the
  query embedding, so the GPU is exclusively the query's.

Gating **only the claim permit** (never the completion permit) is what keeps this
deadlock-free: an already-claimed batch can always finish inference + completion and report
idle; only the *next* batch is held.

### Unit 1 — `createForegroundEmbeddingGate` (new pure module)

`packages/embeddings/src/worker/foreground-embedding-gate.ts`

```ts
interface ForegroundEmbeddingGate {
  begin(): void;                                   // ref-count++; gate closes
  end(): void;                                     // ref-count--; reopens after reopenDelayMs when 0
  isActive(): boolean;                             // count > 0 OR within the reopen-debounce window
  waitUntilInactive(opts?: { signal?: AbortSignal }): Promise<void>; // resolves now if inactive, else on next inactive
}
function createForegroundEmbeddingGate(opts?: {
  reopenDelayMs?: number;   // default 250 — absorbs query bursts so background doesn't thrash
  now?: () => number;
  setTimeout?: ...; clearTimeout?: ...; // injectable for tests
}): ForegroundEmbeddingGate;
```

- Ref-counted so overlapping queries keep the gate closed until all complete.
- `end()` keeps the gate "active" for `reopenDelayMs` after the count hits 0, then reopens
  and notifies any `waitUntilInactive` waiters. A new `begin()` during the debounce cancels
  the pending reopen.
- `waitUntilInactive` is what the composed claim permit awaits.

Also in this module, a small drain helper:

```ts
function waitForWorkerIdle(opts: {
  isActive: () => boolean;
  timeoutMs: number;
  subscribe?: (cb: () => void) => () => void; // optional event source; falls back to polling
  pollMs?: number;          // default 25
  signal?: AbortSignal;
}): Promise<{ drained: boolean }>; // drained=false if it timed out
```

- Resolves `{drained:true}` as soon as `isActive()` is false; `{drained:false}` on timeout.
- Timeout is a safety valve: if a batch is pathologically long/stuck, the query proceeds
  anyway (the claim permit already prevents a *new* batch, so worst case is no worse than
  today). The timeout is logged.

### Unit 2 — compose the gate into the claim permit

`apps/desktop/src/renderer/components/embedding-worker-config.ts`

`createEmbeddingWorkerConfig` gains a `gate` parameter and returns a composed
`waitForBackgroundPermit`:

```ts
waitForBackgroundPermit: async (permitOptions) => {
  await pressureController.waitForBackgroundPermit(permitOptions);
  if (permitOptions?.label === 'embedding claim') {
    await gate.waitUntilInactive({ signal: permitOptions?.signal });
  }
},
```

- DB pressure behavior is unchanged. Only the *claim* permit additionally waits while a
  foreground query is in flight. The completion permit is untouched (deadlock-free).

### Unit 3 — drain + gate in the query handler

`apps/desktop/src/renderer/components/embedding-host-runtime.tsx`

- Create one gate per host runtime (`useRef(createForegroundEmbeddingGate())`), thread it
  into `createEmbeddingWorkerConfig(db, gate)` and into `handleQueryEmbeddingRequest`.
- In `handleQueryEmbeddingRequest`, wrap the existing body:

```ts
gate.begin();
try {
  // (existing fatal/stale checks)
  await waitForWorkerIdle({ isActive: () => activeRef.current, timeoutMs: DRAIN_TIMEOUT_MS });
  const service = await getQueryEmbeddingService(...);   // existing, cached by modelKey
  const result = await service.generateQueryEmbedding(...); // existing
  // (existing report)
} catch (...) { /* existing error report */ }
finally {
  gate.end();
  // (existing queryEmbeddingActiveCountRef decrement + status report)
}
```

- The existing `queryEmbeddingActiveCountRef`/status reporting stays for UI status; the gate
  is the coordination source of truth.

### Constants (module-level; no env unless later requested — YAGNI)

- `FOREGROUND_GATE_REOPEN_MS = 250`
- `QUERY_DRAIN_TIMEOUT_MS = 5000`

(If tuning proves necessary, promote to strict-parsed env vars per the no-silent-fallbacks
rule, mirroring workstream #1's `resilience-config.ts`.)

## Failure modes & edges

- **Drain timeout** → proceed, log; claim permit still blocks new batches.
- **Overlapping queries** → ref-count keeps the gate closed; single debounced reopen.
- **Query throws** → `gate.end()` in `finally`; no stuck-closed gate.
- **Worker idle when query arrives** → `waitForWorkerIdle` resolves immediately; permit
  already passes (gate active only blocks the *next* claim, which simply waits).
- **No worker running / gate absent** → composed permit degrades to the existing DB-only
  behavior.
- **Abort signal** on the permit → `waitUntilInactive` rejects/returns per signal, matching
  the existing pressure-permit abort contract.

## Testing (red → green, deterministic — no GPU timing)

1. **Gate unit**: `begin` closes; `waitUntilInactive` pending until `end` + debounce elapses;
   ref-count with overlapping begin/end; `begin` during debounce cancels reopen; abort
   signal rejects a pending `waitUntilInactive`. (Injected fake timers/clock.)
2. **Drain unit** (`waitForWorkerIdle`): resolves `{drained:true}` when `isActive`→false;
   `{drained:false}` on timeout; respects abort.
3. **Composed-permit unit**: with gate active, a `'embedding claim'` permit waits until the
   gate reopens; a `'embedding completion'` permit and any other label pass through
   immediately; with gate inactive, claim passes through. (Fake pressure permit = resolved.)
4. **Coordination integration (pure)**: scripted sequence proving order — worker `active`,
   query `begin` → claim permit would block → simulate batch end (`active`→false) →
   `waitForWorkerIdle` resolves → query runs → `end` → after debounce the claim permit
   resolves. Asserts the query never runs while `active` is true.

No desktop e2e: the guarantee is structural (claim gated + drained), and a live GPU-timing
assertion would be flaky. Coverage is the deterministic logic tests above. Register any new
`packages/db/__tests__` only (n/a here); embeddings tests run in the embeddings vitest project.

CI-parity gate (AGENTS.md): build + lint + type-check + unit/integration all green together
before opening the PR.

## Files (anticipated)

- New: `packages/embeddings/src/worker/foreground-embedding-gate.ts` (+ test) — gate + drain helper.
- Edit: `packages/embeddings/src/index.ts` / worker entry — export the new factory/types.
- Edit: `apps/desktop/src/renderer/components/embedding-worker-config.ts` — accept `gate`, compose claim permit.
- Edit: `apps/desktop/src/renderer/components/embedding-host-runtime.tsx` — create gate, thread to config + query handler, drain before query.
- Edit: AGENTS.md — extend the EMBEDDING ARCHITECTURE / ASSISTANT RESILIENCE notes with the foreground-query coordination invariant.

## Out of scope (later workstreams / follow-ups)

- Web visible-renderer embedding coordination (#2 follow-up if needed).
- Tool-call UI (#3), reasoning/prompting (#4), toolbar polish (#5).
- Unifying indexing + query into a single embedder/queue (approach C) — not pursued.
