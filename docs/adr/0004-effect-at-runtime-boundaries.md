# ADR-0004: Adopt Effect v4 at runtime boundaries, staged

- **Status:** Accepted; staged adoption completed 2026-10-17. PGlite, `JobQueue` and the Mastra
  agent loop named below have since been removed (ADR-0011, ADR-0012); statements about them are
  historical.
- **Date:** 2026-09-24
- **Tickets:** BST-2044–BST-2052. Current service/RPC choices are in
  [ADR-0024](0024-effect-adoption-service-and-rpc-boundaries.md).
- **Contract:** `docs/agents/effect-boundary.md`.

## Context

Compile-time typing was already strict (one production `as any`, no `@ts-ignore`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`).
Type safety was lost at runtime. A survey at `c4b58bc` counted:

- 3,156 `throw new Error(` and ~2,050 catch blocks; eight hand-written Result types with four
  error shapes.
- 164 `as unknown as` casts and 290 database `.query<T>()` calls with asserted, unchecked row
  types.
- 97 `isRecord` definitions and 481 hand-written type guards.
- Five `withTimeout` helpers, fourteen retry functions, a duplicated FIFO mutex and repeated
  abort helpers. Several timeouts never cleared their timer; most stopped the wait, not the work.

Effect offers a typed error channel, Schema decoding at boundaries, and one set of timeout,
retry, lock and resource primitives where interruption stops the work.

## Decision

Adopt Effect v4 (`effect`, exact-pinned) one runtime boundary at a time.

1. **Phase 0:** the contract, an exact catalog pin, the Effect language service in diagnostics
   mode, and `@brainstrike/effect-kit` with the one Promise-boundary helper.
2. **Phase 1:** small pilots.
   - `runWithTimeout` for timers that never cleared; `createConcurrencyLimiter` for the
     git-inventory walk.
   - FIFO mutexes stay hand-written (Effect's `Semaphore` is not strictly FIFO).
   - Token-cache batch transactions use `Effect.retry` with a bounded exponential `Schedule`,
     keeping the Promise API, rollback, error identity and retry logging. A retry delay beyond
     the native timer range fails at construction.
3. **Phase 2:** Schema at boundaries only main or a worker reaches: Electron main IPC handlers,
   repository row decoding, chunking-worker messages. Host/run identity stays with its owner
   (ADR-0017); no type-only brand mints a second identity.
4. **Phase 3 (narrowed, BST-1819):** desktop main's graceful shutdown runs on effect-kit's
   `runShutdownSequence` from a tested module that owns step order, and every IPC registration's
   disposer joins the disposer stack.
   - Later: [ADR-0027](0027-canonical-electron-quit.md) replaced the sequence engine with plain
     ordered awaits in `desktop-graceful-shutdown.ts`; `runShutdownSequence` is gone.
   - Host managers did not become scoped Layers: shutdown order is a dependency order across
     main, and factory reset is a restartable parallel stop, not a scope closing.
- Later phases (main as a Layer graph, RPC over workers, Stream) each need their own decision.

## Consequences

- Promise and Effect code coexist. Package APIs stay Promise-based until callers are Effect, and
  every crossing goes through `runAtPromiseBoundary`.
- IPC contract modules cannot import `effect` (preloads reach every `*.contract.ts`), so IPC
  Schema validation lives in main-only handler modules.
- Effect stays out of the assistant stream chain and watchdogs until their contracts change.
- ~~zod remains the schema library for LLM tool definitions.~~ Superseded by the 2026-10-15
  amendment.
- Imports are allowlisted: exactly `effect` and `effect/testing`. Any other subpath needs a
  contract change.
- Stability is per API (`@stability` JSDoc: stable, unstable, experimental). The exact pin keeps
  changes reviewable; the language service detects them.

## Alternatives considered

- **Effect v3 (3.22.2).** Stable, but `@effect/vitest` for v3 needs Vitest 3, the TypeScript 7
  language service targets v4, the runtime is ~5x larger (35.2 KB vs 6.9 KB gzipped), and v3 code
  would need migrating.
- **A Result library (neverthrow etc.).** Typed errors only; no interruption, scopes, schedules
  or decoding.
- **zod plus hand-written helpers.** Covers decoding; leaves errors, timeouts and locks as they
  were.

## Amendment (2026-10-15): Effect Schema is the single boundary owner

Two schema libraries cost the most and decided the least (zod in 152 non-test files, Effect
Schema in 50), and an RPC contract is schemas. Effect Schema now owns every boundary, LLM tool
definitions included.

- **Boundary:** a tool declares an Effect Schema and registers it with `effectToolInputSchema`
  ([producer](../../packages/assistant-contract/src/native-tools/schemas/effect-tool-input.ts)).
  - The result carries both the draft-07 JSON Schema sent to the provider and the validator the
    host parses with.
  - The AI SDK's `FlexibleSchema` accepts it as a Standard Schema with a JSON Schema converter;
    `@mastra/schema-compat` accepts it as `StandardSchemaWithJSON`.
- **Rules for new code:**
  - Author tool input in Effect Schema and register it with `effectToolInputSchema`.
  - Read a registered schema through `toToolInputJsonSchema` / `validateToolInputValue`
    ([accessors](../../packages/assistant-contract/src/native-tools/schemas/tool-input-schema.ts)).
  - Never use `Schema.toStandardJSONSchemaV1`: it always emits `additionalProperties: true`.
  - Derivation and decoding take `onExcessProperty: 'error'` together, from one helper.
- **Why the rule matters:** OpenAI's strict layer sets `additionalProperties: false` and Google's
  strips it, so an open derivation looks fine there and reaches Anthropic open.
- **Completion (2026-10-17):** native tool inputs have one Effect producer;
  `providerCompatibleInputSchema` and the zod producer/accessor branches are retired. Remaining
  owners are listed in [schema ownership](../agents/effect-schema-migration.md).
- **Desktop IPC (2026-10-31, BST-2383):** the owner chose split contracts. A `*.contract.ts`
  carries only channel names and types, so preloads still import no Effect; Main registers an
  Effect Schema for every invoke, and the dispatcher decodes it (`onExcessProperty: 'error'`)
  after sender authorization and before the handler. The hand-written `parseArgs` parsers are
  retired.
