# ADR-0004: Adopt Effect v4 at runtime boundaries, staged

- **Status:** Proposed (2026-09-24; accepted when the owner merges this ADR)
- **Date:** 2026-09-24
- **Ticket:** none yet (Linear was not reachable from the authoring session)
- **Contract:** `docs/agents/effect-boundary.md`; measurements in
  `docs/agents/effect-boundary/adoption-review.md`.

## Context

Brainstrike's compile-time typing is already strict: production code has one
`as any`, no `@ts-ignore`, and `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, and `noPropertyAccessFromIndexSignature` are on.
Type safety is lost at runtime instead. A survey of the production tree at
`c4b58bc` counted:

- 3,156 `throw new Error(` calls and about 2,050 catch blocks. Failures travel
  as untyped throws, and eight hand-written Result types use four different
  error shapes.
- 164 `as unknown as` casts, concentrated in db and desktop boundary code, and
  290 PGlite `.query<T>()` calls whose row type is asserted, never checked.
- 97 separate `isRecord` definitions and 481 hand-written `x is T` guards.
- Five `withTimeout` helpers, fourteen retry functions, a FIFO mutex copied into
  two files, and abort helpers redefined in three to five files each. Several
  timeouts never clear their timer, and most stop the wait but not the work.

Effect provides a typed error channel, Schema decoding at boundaries, and one
set of timeout, retry, lock, and resource primitives in which interruption stops
the work itself.

## Decision

Adopt Effect v4 (`effect`, exact-pinned) one runtime boundary at a time.

1. **Phase 0 (this ADR):** the contract, an exact catalog pin, the Effect
   language service in dedicated diagnostics mode, and
   `@brainstrike/effect-kit` holding the one Promise-boundary helper.
2. **Phase 1:** small self-contained pilots: `runWithTimeout` for the timeouts
   that never cleared their timer, and `createConcurrencyLimiter` for the
   git-inventory walk. The FIFO mutexes stay hand-written: Effect's `Semaphore`
   is not strictly FIFO (`effect-boundary/phase-one-pilots.md`).
3. **Phase 2:** Schema at boundaries that only main or a worker reaches: IPC
   handlers in Electron main, PGlite row decoding in repositories, chunking
   worker messages, and a branded host run id.

Later phases (host lifecycles as scoped Layers, RPC over workers,
`@effect/sql-pglite`, Stream) each need their own decision.

## Consequences

- Promise and Effect code coexist for a long time. Package APIs stay
  Promise-based until their callers are Effect code, and every crossing goes
  through `runAtPromiseBoundary`.
- IPC contract modules cannot import `effect`: preloads reach every
  `*.contract.ts`, and the preload import graph rejects bare packages. Schema
  validation in IPC therefore lives in main-only handler modules, not in
  `parseArgs`.
- Effect stays out of the assistant stream chain and watchdogs, the PGlite
  close drain, the durable `JobQueue` (ADR-0002), and the Mastra agent loop
  (ADR-0001) until their own contracts change.
- zod remains the schema library for LLM tool definitions. The AI SDK
  special-cases it, and migrating 99 exported schemas buys little.
- The release candidate still moves: rc.117's `effect/unstable/*` paths were
  renamed on `main` two days after it shipped. The exact pin and the ban on
  unstable imports contain that churn.

## Alternatives considered

- **Effect v3 (3.22.2).** Stable, but `@effect/vitest` for v3 needs Vitest 3,
  the PGlite driver and the TypeScript 7 language service target v4, and its
  minimal runtime is about five times larger (35.2 KB against 6.9 KB gzipped).
  Every line written on v3 would also need a v4 migration.
- **A Result library (neverthrow and similar).** Gives typed errors but not
  interruption, resource scopes, schedules, or schema decoding, which is where
  most of the hand-built machinery above lives.
- **Stay with zod plus hand-written helpers.** Covers decoding but leaves the
  error channel, timeouts, and locks as they are.
