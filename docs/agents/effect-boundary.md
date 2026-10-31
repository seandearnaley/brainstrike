# Effect boundary

## Scope

Effect supports typed boundaries and structured resource ownership. Follow
[ADR-0004](../adr/0004-effect-at-runtime-boundaries.md) and the existing staged
composition, not a repository-wide rewrite. Keep the qualified family pinned
through the package catalog; adopt new or unstable APIs deliberately.

Production code imports `effect` and `effect/testing` and nothing else.
Stability is a separate axis the specifier cannot show: every Effect 4 API
carries a `@stability` tag, and an unstable API may break in a MINOR release,
an experimental one in a PATCH. So "deliberately" means checked, not guessed —
the language service carries `unstableApiUsage` and `experimentalApiUsage`,
takes `allowedUnstableApis`/`allowedExperimentalApis` for a reviewed exception,
and reports a stable signature that exposes a less stable type as
`apiStabilityLeak`. Every module imported today is tagged stable, and those
rules keep it so.

Each project names those three rules as `error` in its `diagnosticSeverity`, and
its type-check script's `effect-tsgo diagnostics --strict` step enforces them.
Enabling the plugin is not enough:
`apiStabilityLeak` ships `off`, and `--strict` only promotes diagnostics that
already run, so a bare plugin entry lets a stable export expose an unstable
Effect type and still type-check.

Effect stays out of preloads and their value-import graph. Shared IPC contracts
retain their pure preload parser surface; host, renderer, main and worker
receiving boundaries may use Schema without importing Effect into preload. Do not move a stream,
watchdog, persistence drain or ordering-sensitive queue to fibers merely because
another subsystem uses them.

## Promise and resource contracts

Public APIs remain Promise-based until their callers use Effect. Cross through
`runAtPromiseBoundary`; preserve the actual typed failure, defect or caller abort
reason. Runtime runners belong in effect-kit, not new per-consumer wrappers.

Use owned cancellation and finalizers. A timeout aborts the actual operation and
clears its timer; racing a timer with unowned work is insufficient. Shutdown keeps
its explicit dependency order, attempts later steps after failure and joins their
cleanup. Reset is restartable and keeps its existing admission barrier rather
than pretending to be an ordinary scope close.

Tool guard deadlines belong to the forwarded execution occurrence, never a
provider call ID. The guard creates a distinct context even when callers reuse
one object; capability and caller AbortSignal references retain their identity.
The registry's public `@brainstrike/agent/tool-guard-deadline` entry resolves to
one emitted CJS owner for both ESM and CJS consumers. Keep it external to other
agent bundles; the emitted-export subprocess test protects this shared state.

The concurrency limiter starts tasks in arrival order. Preserve existing
promise-chain owners where order matters. Partial acquisition rolls back its
resources; stale callbacks cannot settle a replacement. Keep independent errors and failed owners
observable until cleanup settles. Retry transactions through the existing bounded
schedule without losing rollback or original failure identity.

### Named boundary contracts

Each boundary below owns its resources at one Effect seam.

- Provider auth and assistant provider probes bound fetch and body reading together;
  cancellation aborts fetch and polling sleeps, preserving typed failures,
  verdicts and cache provenance.
- The MCP OAuth callback Scope owns listener teardown; each wait uses
  `Effect.ensuring` for timer cleanup, and close joins all active waits.
- Embedding admission reserves partial permits transactionally; abort only
  capacity waits, never committed grants.
- File-tree bulk operations share one Scope-owned pending entry; detach before
  settlement, preserve synchronous posting and first terminal outcome, and clean
  failed sends before replacement.
- Renderer startup adopts `Effect.retry` and always finalizes readiness waits.
- Native-index lifecycle workflows type expected settings, action and event
  refusals until their existing Promise edges. Synchronous capability throws
  remain defects; settings and cleanup failures stay independently visible.
  The reducer, admission permit, immediate fence and physical-retirement owner
  remain authoritative.

`withTimeout` composes the existing owned deadline before its Promise edge;
`runWithTimeout` keeps the Promise/AbortSignal contract. Timing-policy tests
provide `TestClock.layer()` before running Effects. They complement real timer,
socket and process-exit checks rather than replacing physical cleanup evidence.

## Lifecycle diagnostics

Native-index workflow spans use the existing `NativeIndexWorkflow` logger. Session
Logs at info level shows admission, settings, action and terminal phases under one
opaque trace identity; failures also reach the existing warn+ retention path.
The tracer exports only fixed operation/event names, allowlisted actions, opaque
span/parent IDs, durations and outcomes. Causes pass through the existing redactor
and export bounded failure counts, with truncation visible; error text, settings,
paths, prompts and credentials are not span attributes. Terminal spans close after
Effect finalizers. This adds no exporter, telemetry store or resource owner.

Effect's documented Tracer and `Logger.tracerLogger` carry nested workflow context.
A supported Promise edge can pass `tracing: { tracer, parentSpan }` to the existing
`runAtPromiseBoundary`; cancellation and original failure identity stay intact.
There is no automatic ambient propagation across arbitrary callbacks or workers,
and no propagation header or runtime replacement.

## Schema at the LLM tool boundary

Effect Schema owns tool definitions (ADR-0004, amended 2026-10-15). Declare a
tool's input as an Effect Schema and register it with `effectToolInputSchema`;
that one call owns both the provider JSON Schema and the validator, so their
strictness cannot drift. Read a registered schema through
`toToolInputJsonSchema` / `validateToolInputValue` rather than narrowing to a
library at the call site.

Do not use `Schema.toStandardJSONSchemaV1` here: it takes no options and so
always emits `additionalProperties: true`. Derivation and decoding take
`onExcessProperty: 'error'` together. A provider will not reliably catch that
mistake — OpenAI's strict layer closes the object itself and Google's strips the
key, so an open derivation reaches Anthropic open. The remaining zod schemas and
their order are in [the migration plan](effect-schema-migration.md).

## Decoding and tooling

Decode runtime payloads, worker messages and database rows at their receiving
boundary; derive types and check cross-field invariants rather than asserting a
shape. Preserve the established error class/cause and pure preload parser surface.
Type-only brands do not add a runtime producer or identity alias.

Use typed Schema decoders for authored or already validated inputs, preserving
the concrete schema's `Encoded` inference. Keep unknown-input decoders for wire
recordings and deliberately malformed inputs; capabilities still require runtime
validation without cloning their identity.

Decoded fields annotate `message` with old hand-check sentences; predicate-only
`Schema.is` boundaries preserve existing errors in caller code. Python maps
issue paths to legacy `PythonManifestInvalidError` messages, and missing targets
stay unsupported-platform errors. Worker envelope Schema lives behind
`@brainstrike/worker-runtime/validation`: keep the root import light and
preserve plain `Error` sentences, array roots and object identity.

Use the existing effect-kit helpers and package diagnostics. Do not patch the
shared TypeScript compiler as part of a library adoption. Versions, import paths
and diagnostic commands are owned by installed packages and configuration.

Before writing Effect code, resolve `node_modules/effect/src` from the consuming
package, read the installed symbol's implementation and stability tags, and use
that exact release's upstream tests when needed. The root has no Effect runtime
dependency. Local examples are `effect-tool-input.ts` in assistant-contract and
`promise-boundary.ts` / `__tests__/timeout-clock.test.ts` in effect-kit.
Run `pnpm --filter <consumer> exec effect-tsgo diagnostics --project
<its-widest-tsconfig> --strict --format json` for actionable locations, including
related service/declaration locations. The consumer's type-check script selects
its widest project; ordinary Vitest callbacks must return a joined Promise.

Effect consumers run compiler checks and `effect-tsgo diagnostics --strict` on
the widest configured project. Preserve a nonempty checked program and the three
stability severities.

When considering another service graph or RPC engine, consult
[the service/RPC decision](../adr/0024-effect-adoption-service-and-rpc-boundaries.md).

Implementation: `packages/effect-kit` and the owning boundary modules.
