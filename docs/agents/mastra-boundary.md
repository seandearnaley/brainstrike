# Mastra boundary

## Allowed ownership

[ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md) governs current runs:
the host owns one AI SDK loop per root or child. Mastra owns no transcript,
permission system, workspace, server or run coordinator. Do not resurrect the
removed agent loop or its vendor patch under a new name.

The loop's files are gone as of ADR-0022's retirement step: no Brainstrike
production code constructs a Mastra `Agent` or a `Mastra` instance, and nothing
imports `@mastra/core/stream`. A few specs still build one as a harness for the
tool-shape adapters, which is what `@mastra/core` staying means. The host does
construct a public Mastra `Memory` (`HostMemory`), and that `Memory`'s
observational memory builds its own internal observer and reflector `Agent`s
(`@mastra/memory`, `ObserverRunner`/`ReflectorRunner.createAgent`). Those are
the only `Agent` instances in production, and they run inside the memory library.

A patch applies to vendor `dist` whatever our callers do, so a hunk losing its
consumer never fails the install. Reachability has to be argued from what the
hunk CHANGES, not from who constructs the class it lives on.

### Vendor patches (Core 1.78.0, Memory 1.38.0; BST-2070)

`patches/@mastra__core@1.78.0.patch` has one hunk.
`AgentThreadStreamRuntime.prepareRunOptions` forwards the caller's abort reason.
1.71 skipped threadless runs there; 1.78 prepares every run that has a `runId`.
So Memory's internal observer and reflector streams saw a generic `AbortError`,
and the host could not recognize its own Stop. Owner:
`memory-public-lifecycle.test.ts`, specifically:

- "propagates the Memory constructor owner signal…"
- "composes a narrower call signal…"
- "forwards a narrower turn signal to async reflection…"

BST-2070 retired both 1.71 hunk groups by reachability:

- **SemanticRecall's memoized `xxhash_wasm()`.** The change runs only in
  `new SemanticRecall`. Only `MastraMemory.getInputProcessors` and
  `getOutputProcessors` construct it, behind `if (semanticRecall)`. Only `Agent`
  calls those methods. The production `Agent`s are Memory's observer and
  reflector. They get no memory, or `createTemporaryOmMemoryContext`'s vectorless
  `Memory` (semantic recall defaults to `false`). `HostMemory` calls Memory's own
  methods, never its processors.
- **The `BackgroundTaskManager` cleanup-join and the workflow `trackTaskWork`.**
  Only `Mastra#ensureBackgroundTaskManager` and `BackgroundTaskWorker.init`
  construct the manager. Production constructs neither. BST-2068 had already
  deleted the specs that pinned these hunks, together with `pglite-mastra-memory`.

`patches/@mastra__memory@1.38.0.patch` is the M3 lifecycle patch, rebased by
meaning onto 1.38's `runOMCommit` commit queue. Flag writes keep that queue. Unpatched
1.38 fails every case in `memory-public-lifecycle.test.ts` (ESM and CJS). The
groups it carries, and the owner cases that fail when a group is reverted, are
in the BST-2070 PR. Lifecycle groups are owned by `memory-public-lifecycle`,
`memory-adapter` and `memory-native-ownership`. The Core JSON-array group
identities are owned by `observation-memory.integration.test.ts`. The resource
owner overlay and committed resource groups are owned by
`observation-host-lifecycle`, `observation-memory` and `observation-projection`. See
[the M3 memory contract](../../packages/agent-host/src/adapters/memory-m3-contract.md).

The rebase retired five 1.32 lifecycle hunks that no longer have a production
consumer:

- **The OM `reflect()` wrapper.** Only `finalize()` calls `reflect()`, and nothing
  calls `finalize()`.
- **`cleanupStaticMaps`' keep-in-flight branch.** It is reached only from the
  engine's `clear()`, which nothing calls.
- **`Memory.settled`'s `finally` vector join.** It is fed only by Mastra
  `Memory.deleteThread` / `deleteMessages`, which nothing calls, and whose storage
  deletes `StateStoreMemoryStorage` refuses.
- **The `ObservationalMemoryProcessor` turn signal.** That processor exists only on
  `Agent` processor paths.
- **The idle-buffer signal in `ObservationTurn.end`.** It needs `bufferOnIdle`, and
  Brainstrike never sets it.

The only production use of the engine is `HostMemory`'s
`beginTurn`/`start`/`step`/`end`. Neither thread deletion nor factory reset calls
one of those retired paths:

- Thread deletion goes through `HostCore.deleteThread` and then the StateStore
  `purge-thread` memory request.
- Factory reset and content clearing run in desktop main, which imports no
  `@mastra` package. They stop runtimes, reset the database profile or clear
  StateStore content, and delete user data.

Two Memory 1.38 storage contracts reach the host adapters:

- **Outcome-reporting commits.** OM writes active observations through
  `commitActiveObservations` and retries against the head on `applied: false`.
  It appends buffered chunks through `appendBufferedObservations` and drops a
  chunk the store reports as `persisted: false`. `StateStoreMemoryStorage`
  forwards both to the native calculator, so the vendor's own outcome comes back
  unchanged. The base-class defaults would assume success. Both write the
  existing observation entity rows; there is no new table or column.
- **The `record_id` metadata on observation vectors.** It must name one of the
  committed records the indexer's plan holds for that group. The derived index
  keeps its own row identity and does not store it. A recall hit therefore
  carries no `record_id`, and Mastra resolves the generation through its own
  lineage lookup.

`@mastra/memory` is an embedded memory library behind a host adapter, and that is
the only ownership Mastra has. `@mastra/core` is **not** present merely as its
peer: per [ADR-0023](../adr/0023-host-owns-its-tool-representation.md) it is a
direct dependency of `packages/agent`, `packages/agent-host` and
`packages/test-utils`, additionally reached at runtime by hosted tool discovery
(`ToolSearchProcessor`), skills, provider-request shaping (`TripWire`,
`TokenLimiter`, `ProviderHistoryCompat`, `ModelRouterLanguageModel`), the
memory and background-task storage adapters, and schema. Each is a separate
decision on its own evidence — none of them makes Mastra an owner of product state, and none
is a licence to widen the surface. The host's tool representation is its own
(`HostToolDefinition` at the producer, `HostTool` after authority binding, and the AI SDK's `ToolSet` at the edge); do not reintroduce
a vendor tool type as the pipeline's intermediate shape. Producers receive one host execution context with top-level identity and a structural writer; question/plan suspension and per-call network consent belong to HostCore. MCP keeps its raw JSON Schema and Ajv validator; missing validators refuse registration and reopened approvals validate their committed raw input before execution.

Brainstrike owns HTTP entry/auth/origin checks, streaming, tool admission, native
workspace tools and committed persistence. Mastra-owned tables are not altered to
store product state. `@mastra/core` is Node-only and remains externalized from
browser bundles; importing a subpath does not make its shared chunks browser-safe.
Do not introduce Harness, mastracode, libsql, server/deployer adapters or browser
runtime without the corresponding owner decision.

## Memory and context

Construct memory through the existing host resource/thread scope and storage
adapter. Resolve model credentials with Brainstrike's credential owner before
materializing a concrete model; a routing string must not trigger vendor environment
or gateway fallback. Preserve the configured privacy/provider policy and fail
visibly when required model/storage capability is unavailable.

Callbacks, AbortSignals, secrets and process-local resources do not belong in
serialized RequestContext. Client fields are validated and re-derived at the host
boundary; a snapshot cannot supply its own permission or workspace authority.
The committed host log and its projections remain the product UI/persistence
contract, not vendor UI streams or workflows.

## Adapter integrity

Preserve native memory/observation identities and canonical text. Derived search
indexes those records through the existing index owner; no alias row, second
writer or shadow database is introduced. Cancellation and disposal retain physical
resource ownership until their existing joins settle, including independent
cleanup failures.

Adapt protocol/tool results without discarding structured content before the owning
output/persistence boundary. Vendor observability/evals cannot silently become a
new data sink or product store. Any required narrow vendor patch carries its
upstream reference and removal condition at the code that owns it; a version bump
needs the affected adapter proof, not a historical review ritual.

Implementation: `packages/agent-host`, `packages/agent` memory adapters and the
public Memory integration.
