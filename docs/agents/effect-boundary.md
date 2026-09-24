# Effect boundary contract

Owns where the `effect` library may run, how Effect code hands results to
Promise code, and the shared helpers in `@brainstrike/effect-kit`. The decision
and its staging are `docs/adr/0004-effect-at-runtime-boundaries.md`. Update this
file and `scripts/__tests__/effect-boundary-contract.test.mjs` together.

## Adoption

### Version pins

- `effect` and every `@effect/*` package are catalogued at one EXACT version;
  consumers use `catalog:`. Bump them in their own change: read the release
  notes for import-path renames, run every consumer's tests, re-measure bundles.
- Import from `effect` and `effect/testing` only. `effect/unstable/*` needs a
  contract change first. Why: unstable modules move between release candidates.

Evidence: `effect-boundary/adoption-review.md`.
Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Where Effect runs

- Effect core has no runtime dependencies and is browser-safe: renderer,
  workers, hosted web, Node, and Electron main may all import it.
- Never in a preload script or any module a preload reaches. Why: the preload
  import graph rejects every bare package, and `*.contract.ts` IPC modules are
  reachable from `preload.ts`.
- Stay out of the assistant stream chain, tool guard, and watchdogs; the PGlite
  close drain; the durable `JobQueue`; and the Mastra agent loop until their own
  contracts change. Why: each holds ordering or identity invariants that fiber
  interruption does not model.

Guard: `apps/desktop/src/__tests__/preload-sandbox-imports.test.ts`.

### Promise boundaries

- Package APIs stay Promise-based until their callers are Effect code. Effect
  code returns to Promise code only through `runAtPromiseBoundary`
  (`@brainstrike/effect-kit`); production code never calls `Effect.run*`.
- `runAtPromiseBoundary` resolves with the value, rejects with the failure value
  itself (a tagged error keeps its class), rejects with the thrown value for a
  defect, and rejects with `signal.reason` when the caller's signal interrupted
  the effect or was already aborted. Why: the raw runner rejects an abort with a
  generic interruption error and runs a synchronous effect on an aborted signal.

Guard: `packages/effect-kit/src/__tests__/promise-boundary.test.ts`,
`scripts/__tests__/effect-boundary-contract.test.mjs`.

### Shared helpers

- Bound a Promise with `runWithTimeout`, never `Promise.race(work, timer)`: it
  clears its timer when the work settles and aborts the task's signal at the
  deadline.
- `createConcurrencyLimiter` bounds concurrency, not order: a task arriving
  while a permit is momentarily free starts ahead of waiters not yet woken. Code
  that relies on FIFO admission (the snapshot and worktree mutexes) keeps its own
  promise chain.

Evidence: `effect-boundary/phase-one-pilots.md`.
Guard: `packages/effect-kit/src/__tests__/concurrency-limiter.test.ts`,
`timeout.test.ts`.

### Effect diagnostics

- A package that depends on `effect` adds the `@effect/language-service` plugin
  to its `tsconfig.json` and ends its `type-check` script with
  `effect-tsgo diagnostics --project tsconfig.test.json --strict`.
- Never run `effect-tsgo patch`. Why: it rewrites the shared TypeScript 7 `tsc`
  that `ci-quality.md` § "TypeScript 7 CLI with the TypeScript 6 compatibility
  API" pins.

Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.
