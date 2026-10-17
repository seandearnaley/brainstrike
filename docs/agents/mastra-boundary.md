# Mastra boundary

## Allowed ownership

[ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md) governs current runs:
the host owns one AI SDK loop per root or child. Mastra owns no transcript,
permission system, workspace, server or run coordinator. Do not resurrect the
removed agent loop or its vendor patch under a new name.

The loop's files are gone as of ADR-0022's retirement step: no PRODUCTION code
constructs a Mastra `Agent` or a `Mastra` instance, and nothing imports
`@mastra/core/stream`. A few specs still build one as a harness for the memory,
background-task storage and tool-shape adapters, which is what `@mastra/core`
staying means.

`patches/@mastra__core@1.71.0.patch` was narrowed to the hunks that still have a
consumer, which is NOT the same as the hunks the loop did not touch:

- **kept** — `SemanticRecall`'s memoized `xxhash_wasm()` promise (the WASM leak;
  `@mastra/memory` reaches it).
- **kept** — the `BackgroundTaskManager` cleanup-join rewrite and the background
  workflow step that calls its `trackTaskWork`. These are a PAIR, and they
  survive the loop: the contract they create — a cancellation or shutdown joins
  the workflow delete and REPORTS its failure instead of logging a warning — is
  the PGlite background-task storage adapter's, pinned by
  `packages/agent/src/__tests__/background-cleanup.integration.spec.ts`. Removing
  them turned that spec red, which is the patch's removal condition behaving as
  intended.
- **removed** — `createToolCallStep`'s background `outputWriter`, the `Agent`
  sub-agent abort-signal composition, and `createDurableToolCallStep`'s
  `outputWriter`. Each is on the retired loop's own path, with no reachable
  consumer left; a vendor patch nothing reaches is a fork carried for nothing.

A patch applies to vendor `dist` whatever our callers do, so a hunk losing its
consumer never fails the install. Reachability has to be argued from what the
hunk CHANGES, not from who constructs the class it lives on.

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
