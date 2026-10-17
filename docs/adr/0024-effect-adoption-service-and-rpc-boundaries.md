# ADR-0024: Effect adoption keeps explicit resource and protocol owners

- **Status:** Accepted for the completed adoption; future replacements remain deferred.
  Amended 2026-10-17 (BST-2068): the maintenance trigger owner was deleted.
- **Date:** 2026-10-17
- **Ticket:** BST-2052
- **Follows:** [ADR-0004](0004-effect-at-runtime-boundaries.md), [ADR-0017](0017-cli-first-agent-host.md), [ADR-0023](0023-host-owns-its-tool-representation.md)
- **Evidence:** [qualification receipt](../archive/effect-4-adoption-2026-10-17.md)

## Decision

Effect Schema owns the migrated native-tool, shared host/MCP and non-preload desktop
boundaries. Typed expected failures, named lifecycle spans and owned deadlines use
stable Effect APIs at existing seams. Retain explicit physical joins, durable writers
and Promise-facing APIs where they serve their callers. The current native-index
executor stays constructor-injected. SQLite keeps its simpler correlation/process owner.
A repository-wide service graph, ManagedRuntime or RPC engine replacement is deferred.

Completeness means every wave's accepted behavior is demonstrated and every residual
owner is named. It does not require replacing a vendor validator, preload security
boundary or unrelated web owner to make an import counter zero.

## One real service comparison

The compared implementations were `native-index-lifecycle-owner.ts` and
`desktop-maintenance-trigger-graph.ts` in desktop source. The second no longer exists
(see the amendment), so its column is evidence for when a paired Layer earns its place,
not a live owner.

| Concern | Native executor constructor | Maintenance Context.Service/Layer |
| --- | --- | --- |
| Dependency visibility | One explicit executor with `execute` and immediate `fence`; Promise callers need no ambient context | A named `DesktopMaintenanceTriggers` service exposes the paired acquisition result |
| Fake substitution | Existing tests supply a small executor object and held Promise gates | Each trigger supplies its existing Effect acquisition recipe; fake subscriptions exercise the same Layer |
| Acquisition rollback | The lifecycle calls the already-owned physical executor; it acquires no second resource graph | Layer build joins rollback of both subscription/timer groups on partial failure |
| Shutdown | Reducer, permit, immediate fence and physical retirement retain their explicit order | The existing group Scope joins both trigger releases; the pre-build fence also handles synchronous reentrancy |

Keep the executor. A service wrapper around the single executor adds context plumbing
without removing its permit, reducer or physical owner. The paired trigger Layer solved
a real rollback problem while its PGlite maintenance timers existed. Any broader graph must first demonstrate simpler acquisition
and the existing reset/shutdown order with fakes and actual resource joins; its runtime
belongs at effect-kit's sanctioned seam and requires an owner decision before production.

SQLite similarly retains one correlation Map, an actual-exit Promise and distinct first
failure/observed-exit/successful-kill state. Its deadline already uses Effect. Scope or
Deferred wrappers keep those states while adding callback/runtime crossings. The generic
host-lease ResourceOwner caches Scope close and cannot substitute for a retryable failed
kill. E08 instead fixed a demonstrated premature-correlation-release bug and qualified
real query, cancellation, exit, writer reacquisition and replacement behavior.

## RPC recommendation and future acceptance

Retain vscode-jsonrpc. At the closeout source basis `092a2c390`, host protocol version 11
has 81 method grammars and 81 result grammars. Effect owns those grammars already; a new
wire engine has no demonstrated benefit that outweighs the following contracts.

| Contract | Current owner / future proof required |
| --- | --- |
| Handshake and authentication | `connection.ts` gates dispatch on initialize, protocol/host versions and a constant-time 32-byte token comparison; prove refusal before any authority is admitted |
| Methods and identities | Preserve all methods, result validation, transport correlation and separate durable thread/run/command identities |
| Notifications and streams | Map log, child, MCP settings/presentation and live telemetry notifications; preserve commit-before-publish, replay cursors and live-only telemetry |
| Cancellation and terminal replies | Map JSON-RPC cancellation and the host's separate durable Stop semantics; join actual work and dispatch final decoded frames before transport disposal |
| Reconnect and persistence | Keep host lease, data-root lock, generation and committed replay owners; prove reconnect has neither duplicate nor missing durable events |
| Errors | Preserve typed boundary failures, internal-fault redaction and correlation IDs rather than expose raw defects or substitute an RPC-specific error carrier |
| Transports and preload | Qualify stdio, local socket/named pipe and Electron ports with explicit capabilities; keep pure preload value imports outside Effect |
| Version and slow-request strategy | Choose an explicit negotiated wire version; prove incompatible refusal, slow requests/heartbeat, late ping closure, interruption and cleanup without a silent dialect fallback |

The pinned library supplies `RpcSerialization.jsonRpc` and `ndJsonRpc`, which encode
Effect's Request/Ack/Interrupt/Eof/keepalive/terminal vocabulary as JSON-RPC 2.0.
Those serializers make a framing spike feasible; the table's authentication, durable
Stop/replay, error encoding and physical ownership contracts still need proof. Server
requests/notifications are supported in `RpcMessage`, so they should be mapped using
the vendor protocol rather than invented anew. No alternate engine or compatibility
bridge was implemented. A future bounded spike should prove one named contract above
before an owner-approved rollout.

## API stability and authorization

On installed Effect 4.0.5, Context.Service, Layer.effect, Scope, Effect.fn/withSpan,
Tracer and Logger are tagged stable. Rpc, RpcGroup and the `effect/rpc` barrel are
unstable, as are RPC client/server/message/transport APIs. Current production import
allowlist is exactly `effect` and `effect/testing`; `unstableApiUsage`,
`experimentalApiUsage` and `apiStabilityLeak` remain errors.

A descriptor-only candidate using the canonical `effect/rpc` barrel would first need
that exact import added to the reviewed allowlist. The installed tsgo configuration
accepts `allowedUnstableApis` entries by `package/module` subtree or
`package/module#export`. A narrow descriptor review must cover the namespace exports
`effect/rpc#Rpc`, `effect/rpc#RpcGroup` and selected factories
`effect/rpc/Rpc#make`, `effect/rpc/RpcGroup#make`, plus any related unstable types reported
by the checker. Client/server/transport selection adds its own named API review. Resolve
public stability leaks explicitly; keep the three error severities. None of these
exceptions was added, and this decision does not authorize that implementation.

The accepted host-tool representation work in ADR-0023 remains separate from this
adoption. Its future producer-type change can simplify current Mastra seams under its
own acceptance; existing SDK adapters are retained until their consumers actually move.

## Amendment · 2026-10-17 (BST-2068)

#3595 unwired desktop PGlite, and BST-2068 deleted `desktop-maintenance-trigger-graph.ts`
with the PGlite maintenance schedulers it acquired. Desktop source therefore holds no
production Context.Service/Layer acquisition. The native-index executor decision and the
RPC recommendation are unchanged.

## Continuation

All E01–E08 implementation receipts are linked in the archive; E09 closes their census
and decisions. Consult [schema ownership](../agents/effect-schema-migration.md) for the
25 residual production imports and 26 pure IPC contracts. Next work starts from the
owning contract and a concrete authorized outcome, rather than repeating this audit.
