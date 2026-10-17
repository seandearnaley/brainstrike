# Effect boundary

## Scope

Effect supports typed boundaries and structured resource ownership. Follow
[ADR-0004](../adr/0004-effect-at-runtime-boundaries.md) and the existing staged
composition, not a repository-wide rewrite. Keep the qualified family pinned
through the package catalog; adopt new or unstable APIs deliberately.

Production code imports `effect` and `effect/testing` and nothing else — an
allowlist, enforced by `scripts/__tests__/effect-boundary-contract.test.mjs`.
Stability is a separate axis the specifier cannot show: every Effect 4 API
carries a `@stability` tag, and an unstable API may break in a MINOR release,
an experimental one in a PATCH. So "deliberately" means checked, not guessed —
the language service carries `unstableApiUsage` and `experimentalApiUsage`,
takes `allowedUnstableApis`/`allowedExperimentalApis` for a reviewed exception,
and reports a stable signature that exposes a less stable type as
`apiStabilityLeak`. Everything imported today (`Effect`, `Layer`, `Scope`,
`Schema`, `SchemaIssue`, `JsonSchema`, `Schedule`, `Semaphore`, `ManagedRuntime`,
`Stream`) is tagged stable.

Each project names those three rules as `error` in its `diagnosticSeverity`, and
the contract test asserts it. Enabling the plugin is not enough:
`apiStabilityLeak` ships `off`, and `--strict` only promotes diagnostics that
already run, so a bare plugin entry lets a stable export expose an unstable
Effect type and still type-check.

Effect stays out of preloads and their value-import graph. Shared IPC contracts
remain pure; main/worker-side validation may use Schema. Do not move a stream,
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

Concurrency limits do not imply FIFO. Preserve existing promise-chain owners
where order matters. Partial acquisition rolls back its resources; stale
callbacks cannot settle a replacement. Keep independent errors and failed owners
observable until cleanup settles. Retry transactions through the existing bounded
schedule without losing rollback or original failure identity.

### Named boundary contracts

Each boundary below owns its resources at one Effect seam. The measured evidence
sits with the archived contract history; the rules themselves are current and
guarded by `scripts/__tests__/effect-boundary-contract.test.mjs`.

- Provider auth and assistant provider probes bound fetch and body reading together;
  cancellation aborts fetch and polling sleeps, preserving typed failures,
  verdicts and cache provenance.
- The MCP OAuth callback Scope owns listener teardown; each wait uses
  `Effect.ensuring` for timer cleanup, and close joins all active waits.
  Provider OAuth loopback Scope owns listener cleanup; reject duplicate waits,
  and close joins its callback timer and both socket cleanup operations.
- Embedding admission reserves partial permits transactionally; abort only
  capacity waits, never committed grants.
- Parser host generation Scope joins actual exit and listener cleanup; failed
  kills retain ownership and block reuse until retry or exit, and stale
  callbacks never affect replacements.
- OXC IPC request Scope owns its correlation entry and timer; first terminal
  outcome wins, malformed or mismatched replies remain pending, and local
  cleanup never cancels remote parsing.
- Python cold-install scopes join hash-stream and tar-child close before
  staging cleanup; preserve first-caller ownership; committed installs win only
  over late abort, and cleanup failures remain visible.
- File-tree bulk operations share one Scope-owned pending entry; detach before
  settlement, preserve synchronous posting and first terminal outcome, and clean
  failed sends before replacement.
- Renderer startup adopts `Effect.retry` and always finalizes readiness waits.
- Native-index lifecycle workflows type expected settings, action and event
  refusals until their existing Promise edges. Synchronous capability throws
  remain defects; settings and cleanup failures stay independently visible.
  The reducer, admission permit, immediate fence and physical-retirement owner
  remain authoritative.

Evidence (archived):
[provider-auth-lifetimes](../archive/agent-contract-history/effect-boundary/provider-auth-lifetimes.md),
[provider-probe-lifetimes](../archive/agent-contract-history/effect-boundary/provider-probe-lifetimes.md),
[mcp-oauth-callback-scope](../archive/agent-contract-history/effect-boundary/mcp-oauth-callback-scope.md),
[provider-loopback-scope](../archive/agent-contract-history/effect-boundary/provider-loopback-scope.md),
[embedding-admission-permits](../archive/agent-contract-history/effect-boundary/embedding-admission-permits.md),
[parser-generation-scope](../archive/agent-contract-history/effect-boundary/parser-generation-scope.md),
[oxc-request-scopes](../archive/agent-contract-history/effect-boundary/oxc-request-scopes.md),
[python-resource-scopes](../archive/agent-contract-history/effect-boundary/python-resource-scopes.md),
[file-tree-operation-scopes](../archive/agent-contract-history/effect-boundary/file-tree-operation-scopes.md),
[renderer-startup](../archive/agent-contract-history/effect-boundary/renderer-startup.md).

`withTimeout` composes the existing owned deadline before its Promise edge;
`runWithTimeout` keeps the Promise/AbortSignal contract. Timing-policy tests
provide `TestClock.layer()` before running Effects. They complement real timer,
socket and process-exit checks rather than replacing physical cleanup evidence.

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

Decoded fields annotate `message` with old hand-check sentences; predicate-only
`Schema.is` boundaries preserve existing errors in caller code. Python maps
issue paths to legacy `PythonManifestInvalidError` messages, and missing targets
stay unsupported-platform errors. Worker envelope Schema lives behind
`@brainstrike/worker-runtime/validation`: keep the root import light and
preserve plain `Error` sentences, array roots and object identity.

Evidence (archived):
[parser-host-schema](../archive/agent-contract-history/effect-boundary/parser-host-schema.md),
[python-manifest-schema](../archive/agent-contract-history/effect-boundary/python-manifest-schema.md),
[worker-envelope-schema](../archive/agent-contract-history/effect-boundary/worker-envelope-schema.md).

Use the existing effect-kit helpers and package diagnostics. Do not patch the
shared TypeScript compiler as part of a library adoption. Versions, import paths
and diagnostic commands are owned by installed packages and configuration.

Each Effect package therefore type-checks twice: `tsc --noEmit`, then
`effect-tsgo diagnostics --strict`. Folding the second pass into the first needs
`effect-tsgo patch`, which rewrites the shared compiler — and the catalog's
`typescript` is TypeScript 6, which the language service does not support, so
the fold is unavailable until that compiler moves. The duplicate is a known,
measured cost (~35s CPU across the 14 checked projects), not an oversight.

Implementation: `packages/effect-kit` and the owning boundary modules.
