# ADR-0024: Effect adoption keeps explicit resource and protocol owners

- **Status:** Accepted for the completed adoption; future replacements remain deferred.
  Amended 2026-10-17 (BST-2068): the maintenance trigger owner was deleted.
- **Date:** 2026-10-17
- **Ticket:** BST-2052
- **Follows:** [ADR-0004](0004-effect-at-runtime-boundaries.md),
  [ADR-0017](0017-cli-first-agent-host.md),
  [ADR-0023](0023-host-owns-its-tool-representation.md)
- Versions and counts below (Effect 4.0.5, host protocol v11) are as of the decision; the repo
  has since moved on (Effect 4.1.0, protocol v16).

## Decision

- Effect Schema owns the migrated native-tool, shared host/MCP and non-preload desktop
  boundaries.
- Typed expected failures, named lifecycle spans and owned deadlines use stable Effect APIs at
  existing seams.
- Keep explicit physical joins, durable writers and Promise-facing APIs where they serve callers.
- The native-index executor stays constructor-injected.
- SQLite keeps its simpler correlation/process owner.
- Deferred: a repository-wide service graph, `ManagedRuntime`, or an RPC engine replacement.
- "Complete" means every wave's behaviour is demonstrated and every residual owner is named, not
  that an import counter reaches zero by replacing vendor validators or preload boundaries.

## Service comparison

Compared `native-index-lifecycle-owner.ts` (constructor-injected executor) with the since-deleted
`desktop-maintenance-trigger-graph.ts` (a `Context.Service` / Layer).

- **Keep the executor.** A service wrapper around one executor adds context plumbing without
  removing its permit, reducer or physical owner.
- The paired trigger Layer earned its place only because it solved a real partial-acquisition
  rollback problem.
- Any broader graph must first prove simpler acquisition and the existing reset/shutdown order
  with fakes and real resource joins, at effect-kit's sanctioned seam, with an owner decision.
- **SQLite** keeps one correlation `Map`, an actual-exit Promise and distinct
  first-failure / observed-exit / successful-kill state. Its deadline already uses Effect.
  - Scope or Deferred wrappers would add crossings without removing those states.
  - The generic host-lease `ResourceOwner` caches Scope close and cannot model a retryable failed
    kill.
  - E08 instead fixed a premature correlation-release bug and qualified query, cancel, exit,
    writer reacquisition and replacement.

## RPC: keep vscode-jsonrpc

Effect already owns the protocol's method and result grammars; a new wire engine shows no benefit
that outweighs these contracts. A future replacement must prove each:

- **Handshake/auth:** `connection.ts` gates dispatch on initialize, protocol/host versions and a
  constant-time 32-byte token comparison. Prove refusal before any authority is admitted.
- **Methods and identities:** all methods, result validation, transport correlation, and separate
  durable thread/run/command identities.
- **Notifications and streams:** commit-before-publish, replay cursors and live-only telemetry.
- **Cancellation:** JSON-RPC cancellation vs the host's durable Stop; join real work and send
  final frames before disposing the transport.
- **Reconnect:** host lease, data-root lock, generation and replay owners; no duplicate or missing
  durable events.
- **Errors:** typed boundary failures, internal-fault redaction, correlation IDs.
- **Transports:** stdio, local socket / named pipe, Electron ports; preload value imports stay
  outside Effect.
- **Versioning:** explicit negotiated wire version; prove refusal, slow requests, heartbeat and
  cleanup with no silent dialect fallback.

Effect's `RpcSerialization.jsonRpc` / `ndJsonRpc` make a framing spike feasible, and `RpcMessage`
supports server requests and notifications. No alternate engine or bridge was built. A future
spike should prove one named contract before an owner-approved rollout.

## API stability

- Stable at decision time: `Context.Service`, `Layer.effect`, `Scope`, `Effect.fn` / `withSpan`,
  `Tracer`, `Logger`.
- Unstable: `Rpc`, `RpcGroup`, the `effect/rpc` barrel, and RPC client/server/message/transport.
- Production imports are allowlisted to exactly `effect` and `effect/testing`;
  `unstableApiUsage`, `experimentalApiUsage` and `apiStabilityLeak` stay errors.
- Using `effect/rpc` would need that import allowlisted plus narrow `allowedUnstableApis` entries
  (e.g. `effect/rpc#Rpc`, `effect/rpc#RpcGroup`, `effect/rpc/Rpc#make`,
  `effect/rpc/RpcGroup#make`). None was added; this ADR does not authorize it.
- ADR-0023's host-tool representation change was separate from this adoption (it has since
  landed).

## Amendment (2026-10-17, BST-2068)

- #3595 unwired desktop PGlite; BST-2068 deleted `desktop-maintenance-trigger-graph.ts` with the
  maintenance schedulers it acquired.
- Desktop source holds no production `Context.Service` / Layer acquisition. The executor decision
  and RPC recommendation are unchanged.

## Continuation

- E09 closed the E01–E08 waves.
- Residual production imports and pure IPC contracts are listed in
  [schema ownership](../agents/effect-schema-migration.md).
- Start new work from the owning contract and a concrete authorized outcome, not a repeat audit.
