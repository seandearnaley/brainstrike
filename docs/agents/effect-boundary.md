# Effect boundary contract

Owns where `effect` runs, its Promise boundary, and `@brainstrike/effect-kit`; staging: `docs/adr/0004-effect-at-runtime-boundaries.md`.
Update this file and `scripts/__tests__/effect-boundary-contract.test.mjs` together.

## Adoption

### Version pins

- `effect` and every `@effect/*` package are catalogued at one EXACT version;
  consumers use `catalog:`. Bump separately: read release notes for import-path
  renames, run every consumer's tests, re-measure bundles.
- Import from `effect` and `effect/testing` only; all other subpaths need a
  contract change first, including renamed unstable APIs without `/unstable/`.

Evidence: `effect-boundary/adoption-review.md`, `effect-boundary/rc118-qualification.md`.
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

Guard: `packages/effect-kit/src/__tests__/promise-boundary.test.ts`, `scripts/__tests__/effect-boundary-contract.test.mjs`.

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
- Provider auth and assistant provider probes bound fetch and body reading together; cancellation aborts fetch and polling sleeps, preserving typed failures, verdicts and cache provenance.
- The MCP OAuth callback Scope owns listener teardown; each wait uses `Effect.ensuring` for timer cleanup, and close joins all active waits. Provider OAuth loopback Scope owns listener cleanup; reject duplicate waits, and close joins its callback timer and both socket cleanup operations.
- Embedding admission reserves partial permits transactionally; abort only capacity waits, never committed grants.
- OXC IPC request Scope owns its correlation entry and timer; first terminal outcome wins, malformed or mismatched replies remain pending, and local cleanup never cancels remote parsing.
- Python cold-install scopes join hash-stream and tar-child close before staging cleanup; preserve first-caller ownership; committed installs win only over late abort, and cleanup failures remain visible.

Evidence: `effect-boundary/phase-one-pilots.md`, `effect-boundary/phase-three-lifecycle.md`, `effect-boundary/token-cache-retry.md`, `effect-boundary/provider-auth-lifetimes.md`, `effect-boundary/provider-probe-lifetimes.md`, `effect-boundary/mcp-oauth-callback-scope.md`, `effect-boundary/embedding-admission-permits.md`, `effect-boundary/provider-loopback-scope.md`, `effect-boundary/python-resource-scopes.md`, `effect-boundary/oxc-request-scopes.md`.
Guard: `packages/effect-kit/src/__tests__/concurrency-limiter.test.ts`, `timeout.test.ts`, `shutdown-sequence.test.ts`, `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Desktop composition refactors

- Preserve pre-ready bootstrap, each IPC registration's timing, and app-ready
  acquisition; early handlers resolve app-ready services at call time.
- Keep `runShutdownSequence` for named graceful shutdown; factory reset retains
  parallel restartable stops, its database barrier and renderer-ready gate.
- Extraction preserves current startup-failure, reset and stale DB-client behavior.
  A whole-main Layer graph requires a separate decision with measured benefit.

Evidence: `effect-boundary/desktop-composition-root.md`, `effect-boundary/renderer-startup.md`.
Decision: `docs/adr/0005-desktop-composition-root.md`.
Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Desktop maintenance scopes

- A narrow Context/Layer scope owns both maintenance triggers and subscriptions, never admitted SQL.
  Stop fences automatic dispatch synchronously; close joins finalizers before DB drain.
- Preserve native unref interval cadence, separate admission policies and reset barriers;
  partial graph acquisition rolls back both triggers, and all cleanup failures stay visible.

Decision: `docs/adr/0006-scoped-desktop-maintenance.md`. Evidence: `effect-boundary/desktop-maintenance-runtime.md`.
Guard: `apps/desktop/src/__tests__/maintenance-trigger-runtime.test.ts`, `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Schema at boundaries

- Decode PGlite rows, worker messages, and main-only IPC payloads with Effect
  Schema on arrival; derive row types, never cast. Check cross-field invariants in code.
- Decoded fields annotate `message` with old hand-check sentences; predicate-only
  `Schema.is` boundaries preserve existing errors in caller code. Throwing decoders use
  `makeThrowingDecoder`: `TypeError` with message/path and `SchemaError` cause.
  Python maps issue paths to legacy `PythonManifestInvalidError` messages; missing targets stay unsupported-platform errors.
- Count affected rows from `RETURNING`, never a driver row count. Why: the desktop DB host surfaces only `rows`.
- A renderer-minted id is a type-only `Brand.Brand`, asserted once by its sole producer; Schema decoding adds about 74 KB gzipped.
- Worker envelope Schema lives behind `@brainstrike/worker-runtime/validation`; keep the root import light and preserve plain `Error` sentences, array roots, and object identity.

Evidence: `effect-boundary/phase-two-boundaries.md`, `effect-boundary/parser-host-schema.md`, `effect-boundary/python-manifest-schema.md`, `effect-boundary/worker-envelope-schema.md`.
Guard: `packages/db/__tests__/mcp-task-row-schema.test.ts`,
`packages/effect-kit/src/__tests__/throwing-decoder.test.ts`,
`scripts/assistant-run-id-producer-guard.mjs`, `scripts/__tests__/effect-boundary-contract.test.mjs`.

### Effect diagnostics

- Each package depending on `effect` adds the `@effect/language-service` plugin to `tsconfig.json` and ends `type-check` with `effect-tsgo diagnostics --project <widest tsconfig> --strict` (`tsconfig.test.json` if present).
- Never run `effect-tsgo patch`: it rewrites shared TypeScript 7 `tsc`, pinned by `ci-quality.md` § "TypeScript 7 CLI with the TypeScript 6 compatibility API".

Guard: `scripts/__tests__/effect-boundary-contract.test.mjs`.
