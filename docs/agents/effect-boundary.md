# Effect boundary

Effect supplies typed boundaries and structured resource ownership at chosen
seams; it is not a repository-wide rewrite.
Decisions: [ADR-0004](../adr/0004-effect-at-runtime-boundaries.md),
[service/RPC choices](../adr/0024-effect-adoption-service-and-rpc-boundaries.md).
Implementation: `packages/effect-kit` and the owning boundary modules.
Schema ownership details: [Effect Schema ownership](effect-schema-migration.md).

## Scope and stability

- The Effect family is pinned in the pnpm catalog. Production code imports only
  `effect` and `effect/testing`; the root has no Effect runtime dependency.
- Every Effect 4 API has a `@stability` tag; unstable APIs may break in a minor,
  experimental ones in a patch.
  - Each Effect project sets `unstableApiUsage`, `experimentalApiUsage` and
    `apiStabilityLeak` to `error` in its `diagnosticSeverity`.
  - Its type-check runs `effect-tsgo diagnostics --strict` on its widest project.
    Enabling the plugin alone is not enough: `apiStabilityLeak` ships `off`, and
    `--strict` only promotes diagnostics that already run.
  - Reviewed exceptions go in `allowedUnstableApis` / `allowedExperimentalApis`.
  - Keep a nonempty checked program; never patch the shared TypeScript compiler
    (`effect-tsgo patch`).
- Before writing Effect code, read the installed symbol in
  `node_modules/effect/src` from the consuming package, including its stability tag.
- Effect stays out of preloads and their value-import graph. Shared IPC contracts
  are type-only, and Main decodes each desktop invoke's arguments with the Schema it
  registers for that method; host, renderer, main and worker receivers may use Schema.
- Do not move a stream, watchdog, persistence drain or ordering-sensitive queue to
  fibers just because another subsystem did.

## Promises and resources

- Public APIs stay Promise-based until their callers use Effect.
  - Cross with `runAtPromiseBoundary`, preserving typed failure, defect or the
    caller's abort reason. Runners live in effect-kit, not per-consumer wrappers.
  - `withTimeout` composes the owned deadline before the Promise edge;
    `runWithTimeout` keeps the Promise/AbortSignal contract.
- Cancellation and finalizers are owned.
  - A timeout aborts the real operation and clears its timer; racing a timer with
    unowned work is insufficient.
  - Shutdown keeps explicit dependency order, still attempts later steps after a
    failure and joins their cleanup.
  - Reset is restartable and keeps its admission barrier; it is not an ordinary
    scope close.
- Tool guard deadlines belong to the forwarded execution occurrence, never a
  provider call ID.
  - The guard creates a distinct context even when callers reuse one object;
    capability and caller AbortSignal references keep their identity.
  - `@brainstrike/agent/tool-guard-deadline` resolves to one emitted CJS owner for
    ESM and CJS; keep it external to other agent bundles (an emitted-export
    subprocess test guards this).
- The concurrency limiter starts tasks in arrival order.
  - Keep existing promise-chain owners where order matters.
  - Partial acquisition rolls back; stale callbacks cannot settle a replacement.
  - Independent errors and failed owners stay observable until cleanup settles.
  - Transaction retries use the existing bounded schedule, keeping rollback and the
    original failure identity.
- Timing-policy tests provide `TestClock.layer()`; they complement, not replace,
  real timer, socket and process-exit checks. Vitest callbacks return a joined Promise.

## Named boundaries

- Provider auth and provider probes bound fetch and body reading together;
  cancellation aborts fetch and polling sleeps, keeping typed failures, verdicts
  and cache provenance.
- MCP OAuth callback: a Scope owns listener teardown; each wait uses
  `Effect.ensuring` for its timer; close joins all active waits.
- File-tree bulk operations share one Scope-owned pending entry: detach before
  settlement, keep synchronous posting and the first terminal outcome, clean failed
  sends before replacement.
- Renderer startup uses `Effect.retry` and always finalizes readiness waits.

## Schema at the LLM tool boundary

Effect Schema owns tool definitions (ADR-0004, amended 2026-10-15).

- Declare tool input as an Effect Schema and register it with
  `effectToolInputSchema`; that one call owns both the provider JSON Schema and the
  validator, so their strictness cannot drift.
- Read registered schemas through `toToolInputJsonSchema` /
  `validateToolInputValue`, never by narrowing to a library at the call site.
- Never use `Schema.toStandardJSONSchemaV1` here: it takes no options and always
  emits `additionalProperties: true`.
  - Derivation and decoding take `onExcessProperty: 'error'` together.
  - Providers won't catch the mistake: OpenAI's strict layer closes the object and
    Google strips the key, so an open derivation reaches Anthropic open.

## Decoding

- Decode payloads, worker messages and database rows where they are received;
  derive types and check cross-field invariants instead of asserting shapes.
- Keep the established error class and cause.
  Type-only brands add no runtime producer or identity alias.
- Typed decoders (`decodeSync` / `decodeResult`) for authored or already validated
  input; `decodeUnknown*` for real unknown receivers and malformed fixtures.
  Capabilities still need runtime validation without cloning their identity.
- Decoded fields annotate `message` with the old hand-check sentences;
  predicate-only `Schema.is` boundaries keep their existing caller errors.
- Python manifest issues map to `PythonManifestInvalidError` messages; missing
  targets stay unsupported-platform errors.
- Diagnostics: `pnpm --filter <consumer> exec effect-tsgo diagnostics --project
  <widest-tsconfig> --strict --format json`.
- Examples: `effect-tool-input.ts` (assistant-contract), `promise-boundary.ts` and
  `__tests__/timeout-clock.test.ts` (effect-kit).
