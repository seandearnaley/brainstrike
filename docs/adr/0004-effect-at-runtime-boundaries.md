# ADR-0004: Adopt Effect v4 at runtime boundaries, staged

- **Status:** Proposed (2026-09-24; accepted when the owner merges this ADR)
- **Date:** 2026-09-24
- **Ticket:** none yet (Linear was not reachable from the authoring session)
- **Contract:** `docs/agents/effect-boundary.md`; measurements in
  `docs/archive/agent-contract-history/effect-boundary/adoption-review.md`.

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
   Token-cache batch transactions also use `Effect.retry` with a bounded
   exponential `Schedule`. The Promise API, transaction rollback, error identity,
   and retry log contract remain. Configurations whose largest retry delay
   exceeds the native timer range now fail at construction, instead of relying
   on platform-specific timeout overflow behavior
   (`effect-boundary/token-cache-retry.md`).
3. **Phase 2:** Schema at boundaries that only main or a worker reaches: IPC
   handlers in Electron main, PGlite row decoding in repositories, and chunking
   worker messages. The host run id, minted in the renderer, gets a type-only
   brand instead.
4. **Phase 3 (narrowed, BST-1819):** desktop main's graceful shutdown runs on
   effect-kit's `runShutdownSequence` from a tested module that owns the step
   order, and every IPC registration's disposer joins the disposer stack. Host
   managers did not become scoped Layers: shutdown order is a dependency order
   across all of main, not the reverse of construction order, and factory reset
   is a restartable parallel stop, not a scope closing
   (`effect-boundary/phase-three-lifecycle.md`).

Later phases (main's composition root as a Layer graph, RPC over workers,
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
  **Superseded by the 2026-10-15 amendment below.**
- Import churn is contained by an allowlist, not by a ban on one directory.
  `effect/unstable/*` existed when this ADR was written and was dropped in
  rc.118; the contract allows exactly `effect` and `effect/testing`, so that
  deletion cost nothing and every other subpath still needs a contract change.
- Stability is no longer visible in the import path. In Effect 4 each API
  carries a `@stability` JSDoc tag — stable, unstable or experimental — and an
  unstable API may break in a minor, an experimental one in a patch. The exact
  pin is what keeps that reviewable; the language service is what detects it.

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

## Amendment (2026-10-15): Effect Schema is the single boundary owner

Carrying two schema libraries is the option that costs most and decides least.
The repository had zod at 152 non-test files and Effect Schema at 50, and an RPC
contract is schemas — so the unanswered question blocked putting the host
protocol onto a schema-derived contract. Effect Schema now owns every boundary,
LLM tool definitions included. The paragraph above reserving zod for tool
definitions is superseded.

**Where the boundary sits.** A tool declares an Effect Schema and registers it
through `effectToolInputSchema`
([producer](../../packages/assistant-contract/src/native-tools/schemas/effect-tool-input.ts)).
That one call returns a value carrying both halves of the boundary: the
draft-07 JSON Schema the provider is sent, and the validator the host parses
tool input with. The AI SDK needs no adapter — `FlexibleSchema` admits a
Standard Schema whose props carry a `StandardJSONSchemaV1.Converter`
(`@standard-schema/spec` 1.1.0), and `@mastra/schema-compat` accepts the same
value as a `StandardSchemaWithJSON`. The per-provider compat layer and
`prepareHostProviderTools` were not changed.

**The rule new code follows.** Author the tool's input in Effect Schema and
register it with `effectToolInputSchema`. Read a registered schema through
`toToolInputJsonSchema` / `validateToolInputValue`
([accessors](../../packages/assistant-contract/src/native-tools/schemas/tool-input-schema.ts)),
never by narrowing to a library at the call site. Do not use
`Schema.toStandardJSONSchemaV1`: it takes no options, so it always emits
`additionalProperties: true` and would advertise an open object for a tool whose
validator rejects unknown keys. Derivation and decoding must take
`onExcessProperty: 'error'` together, from one helper, or the advertised
contract and the enforced one drift.

That drift does not fail uniformly, which is why it is stated as a rule rather
than left to a provider to catch: OpenAI's strict layer sets
`additionalProperties: false` itself and Google's layer strips the key, so an
open derivation looks correct on both and reaches Anthropic open.

**Staging.** Each tool has exactly one producer; `NativeToolInputSchema` is the
union of the two while the remaining zod schemas are converted, and the catalog
spec refuses a schema that is neither. `providerCompatibleInputSchema` is the
zod producer being retired, and both producers share one
`normalizeProviderNulls`, so a provider `null` means omission of a declared
optional property whoever authored the schema. The order for the remaining
boundaries is [the migration plan](../agents/effect-schema-migration.md).
