# Mastra boundary

## Allowed ownership

[ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md) governs current runs:
the host owns one AI SDK loop per root or child. Mastra is an embedded memory
library behind a host adapter. It does not own a second transcript, permission
system, workspace, server or run coordinator. Do not resurrect the removed agent
loop or its vendor patch under a new name.

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
