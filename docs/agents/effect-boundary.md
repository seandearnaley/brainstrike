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
`Schema`, `Schedule`, `Semaphore`, `ManagedRuntime`, `Stream`) is tagged stable,
and the three rules pass at `error` severity on the current tree.

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

## Decoding and tooling

Decode runtime payloads, worker messages and database rows at their receiving
boundary; derive types and check cross-field invariants rather than asserting a
shape. Preserve the established error class/cause and pure preload parser surface.
Type-only brands do not add a runtime producer or identity alias.

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
