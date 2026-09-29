# Phase 1 pilots — evidence

Supports `docs/agents/effect-boundary.md` § "Shared helpers". The record of
which hand-built primitives moved onto effect-kit in Phase 1 of ADR-0004, which
did not, and the measurements behind each call (2026-09-24, effect 4.0.0-rc.117).

## Moved

- `runWithTimeout` replaced two `Promise.race(work, timer)` copies whose timers
  were never cleared:
  - `packages/chunking-worker/src/chunking.worker.ts` (`createTimeout`, a
    60-second timer left pending per processed file);
  - `packages/embeddings/src/device-detection.ts` (a local
    `createTimeoutPromise` around the 5-second WebGPU adapter request, whose
    timeout path had no test until this change).
  Neither task accepts a signal, so work that outlives its deadline still runs;
  only the timer leak is fixed. The unit test counts Node `Timeout` resources
  before and after to prove the timer is released.
- `createConcurrencyLimiter` replaced the hand-written counting semaphore in
  `apps/desktop/src/assistant-server/git-inventory-discovery.ts`. The walk only
  needs a bound on concurrent `readdir`s. With the build's abort signal passed
  to the limiter, `stop()` now also drops `readdir`s still queued for a permit
  instead of letting each one start and then return.

## Bundle cost

- Effect reached three renderer chunks: the web and desktop chunking-worker
  chunks and the desktop renderer's main chunk (through device detection).
  Desktop main keeps packages external and `require`s `@brainstrike/effect-kit`.
- All three effect-kit helpers bundled alone with Vite 8 (Rolldown), minified:
  46.0 KB, 13.2 KB gzip -9.

## Not moved, and why

- **The FIFO mutexes** in `snapshot-service.ts` and `worktree-service.ts`.
  Effect's `Semaphore` wakes waiters from a `Set` in insertion order, but
  `take` succeeds immediately whenever a permit is free, and the wake-up is
  scheduled on a later task. A caller arriving between a release and that
  wake-up takes the permit ahead of a waiter queued earlier. Both mutexes
  document FIFO admission, and snapshot and restore requests run in submission
  order today; changing that needs its own review, so they keep their
  seven-line promise chain.
- **`packages/queue` `createTimeoutPromise`.** It is exported but has no
  production caller; the live copies were the two above.
- **`packages/agent` resilience config via Effect `Config`.** The config feeds
  the assistant watchdog chain the contract keeps Effect out of. Separately,
  Effect's default `ConfigProvider` did not see a `process.env` change made after
  its first read in a Node test, while the current `readEnv` reads on every call.
- **A Logger-to-Pino bridge.** No Phase 1 code logs through Effect; it lands with
  its first caller.

## Follow-up cleanup (2026-09-25)

- Removed the unused `packages/queue` `createTimeoutPromise` export and its
  helper-only tests after a repository-wide reference search found no production
  caller. The Phase 1 finding above records its state at the time of that pilot.
- `GPU.requestAdapter` has no signal option, so `runWithTimeout` bounds the
  device-detection wait and clears its timer but cannot cancel the browser's
  adapter request. `chunkContent` has no signal option and performs synchronous
  work that can delay the timer callback itself.
  Cooperative yields and cancellation checks would be needed to stop that work.
  Adding an unused signal to either call would imply cancellation that does not
  happen. After a timeout the chunking worker drops the eventual return value,
  but `processFile` can still emit progress or logs before it returns.
- Validation: focused queue utility, device detection, and desktop shutdown
  tests passed (77 tests total); queue, chunking-worker, embeddings, and
  effect-kit type checks passed, including zero Effect diagnostics findings;
  agent and Effect contract scripts passed (13 tests). No bundle measurement was
  taken because this cleanup adds no renderer-reachable import or runtime path.
  No new behavioral guard was needed for comments and an unused export removal.
