# Effect boundary contract

Owns where `effect` runs, its Promise boundary, and `@brainstrike/effect-kit`; staging: `docs/adr/0004-effect-at-runtime-boundaries.md`.
Update this file and `scripts/__tests__/effect-boundary-contract.test.mjs` together.

## Adoption

### Version pins

- `effect` and every `@effect/*` package are catalogued at one EXACT version;
  consumers use `catalog:`. Bump separately: read release notes for import-path
  renames, run every consumer's tests, re-measure bundles.
- Import from `effect` and `effect/testing` only. `effect/unstable/*` needs a
  contract change first. Why: unstable modules move between release candidates.

Evidence: `effect-boundary/adoption-review.md`.
Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Where Effect runs

- Effect core has no runtime dependencies and is browser-safe: renderer,
  workers, hosted web, Node, and Electron main may import it.
- Never in a preload or any module it reaches: its import graph rejects bare
  packages, and `*.contract.ts` IPC modules are reachable from `preload.ts`.
- Stay out of the assistant stream chain, tool guard, watchdogs, PGlite close
  drain, durable `JobQueue`, and Mastra agent loop until their contracts change:
  fiber interruption does not model their ordering or identity invariants.

Guard: `apps/desktop/src/__tests__/preload-sandbox-imports.test.ts`.

### Promise boundaries

- Package APIs stay Promise-based until callers use Effect. Cross back via `runAtPromiseBoundary`; outside effect-kit, no `Effect.run*` or runtime.
- `runAtPromiseBoundary` resolves with the value; rejects with the failure itself
  (preserving tagged classes), thrown defects, or `signal.reason` on caller interruption or prior abort.

Guard: `packages/effect-kit/src/__tests__/promise-boundary.test.ts`,
`scripts/__tests__/effect-boundary-contract.test.mjs`.

### Shared helpers

- Bound a Promise with `runWithTimeout`, never `Promise.race(work, timer)`:
  it clears its timer when work settles and aborts the signal at the deadline.
- `createConcurrencyLimiter` bounds concurrency, not order: a task arriving
  while a permit is free can start ahead of waiters not yet woken. FIFO users
  (snapshot and worktree mutexes) keep their promise chain.
- Ordered teardown runs through `runShutdownSequence`, in an explicit order: a
  failed step never skips a later one; at the deadline the running step aborts.
- Retry token-cache transactions with `Effect.retry` and a bounded `Schedule`:
  preserve rollback, failure identity and logs; reject out-of-range delays.
- Provider auth bounds fetch and body reading together; cancellation aborts fetch
  and polling sleeps, preserving typed failures and adapter-owned outcomes.

Evidence: `effect-boundary/phase-one-pilots.md`, `effect-boundary/phase-three-lifecycle.md`, `effect-boundary/token-cache-retry.md`, `effect-boundary/provider-auth-lifetimes.md`.
Guard: `packages/effect-kit/src/__tests__/concurrency-limiter.test.ts`,
`timeout.test.ts`, `shutdown-sequence.test.ts`.

### Desktop composition refactors

- Preserve pre-ready bootstrap, each IPC registration's timing, and app-ready
  acquisition; early handlers resolve app-ready services at call time.
- Keep `runShutdownSequence` for named graceful shutdown; factory reset retains
  parallel restartable stops, its database barrier and renderer-ready gate.
- Extraction preserves current startup-failure, reset and stale DB-client behavior.
  A desktop Layer graph requires a separate decision with measured benefit.

Evidence: `effect-boundary/desktop-composition-root.md`.
Decision: `docs/adr/0005-desktop-composition-root.md`.
Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Desktop maintenance scopes

- Effect scopes own maintenance triggers and subscriptions, never admitted SQL.
  Stop fences automatic dispatch synchronously; close joins finalizers before DB drain.
- Preserve native unref interval cadence, separate admission policies and reset barriers;
  failed acquisition releases its resources, and cleanup failures stay visible.

Decision: `docs/adr/0006-scoped-desktop-maintenance.md`. Evidence: `effect-boundary/desktop-maintenance-runtime.md`.
Guard: `apps/desktop/src/__tests__/maintenance-trigger-runtime.test.ts`, `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Schema at boundaries

- Decode PGlite rows, worker messages, and main-only IPC payloads with Effect
  Schema on arrival; derive row types, never cast. Check cross-field invariants in code.
- Each field schema's `message` is its old hand-check sentence. Throwing code uses
  `makeThrowingDecoder`: `TypeError` with message/path and `SchemaError` as `cause`.
- Count affected rows from `RETURNING`, never a driver row count. Why: the
  desktop DB host surfaces only `rows`.
- An id the renderer mints is a type-only `Brand.Brand`, asserted once by its
  sole producer and guard-pinned: Schema decoding adds about 74 KB gzipped.

Evidence: `effect-boundary/phase-two-boundaries.md`, `effect-boundary/parser-host-schema.md`.
Guard: `packages/db/__tests__/mcp-task-row-schema.test.ts`,
`packages/effect-kit/src/__tests__/throwing-decoder.test.ts`,
`scripts/assistant-run-id-producer-guard.mjs`.

### Effect diagnostics

- Each package depending on `effect` adds the `@effect/language-service` plugin
  to `tsconfig.json` and ends `type-check` with `effect-tsgo diagnostics --project <widest tsconfig> --strict` (`tsconfig.test.json` if present).
- Never run `effect-tsgo patch`: it rewrites shared TypeScript 7 `tsc`, pinned by
  `ci-quality.md` § "TypeScript 7 CLI with the TypeScript 6 compatibility API".

Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.
