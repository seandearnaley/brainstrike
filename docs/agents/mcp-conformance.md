# MCP conformance

Use this contract when changing the protocol lab, official conformance client,
runner or evidence validation. The lab verifies protocol behavior; it does not
establish packaged desktop UX or live-provider acceptance. Local validation and
CI authorization belong to [validation guidance](ci-quality.md).

## Verification boundaries

[The MCP test lab](../../packages/mcp-test-lab/src/) is Node-only and independent
of production clients. It reaches shared protocol shapes through the Tasks
extension package and must not enter an application dependency graph. Expose a
verifier capability only when its executable implementation exists; a declaration
or upstream CLI listing is not proof that it ran.

The scenario manifest owns executable fixtures, transports, negotiated revisions,
capabilities and upstream provenance. Profiles derived from upstream examples
must identify their limited coverage rather than claim complete upstream
conformance. Unknown scenarios or mismatched provenance fail visibly. Use
explicit isolated environments and lab-owned loopback listeners or subprocesses,
not ambient credentials or an owner's configured servers.

Owners: [scenarios](../../packages/mcp-test-lab/src/scenario.ts),
[runner manifest](../../packages/mcp-test-lab/src/runner-manifest.ts).

## Evidence integrity

Treat supplied evidence as untrusted. Validate its closed schema and sanitize
metadata before dependency I/O. Independently scan referenced artifact content;
a claimed sanitization flag is not proof. Read each unique reference within an
explicit byte bound, hash copied bytes, decode text strictly, and return only a
detached immutable bundle. Diagnostics contain bounded codes rather than secret
artifact content.

Evidence distinguishes protocol-lab applicability from desktop-required proof.
Bind results to the actual workspace, installed runtime, selected fixture and
executed scenario. Missing cleanup proof blocks successful evidence. Historical
pins and run links stay in the owning manifest or archived evidence, not duplicated
as current acceptance claims.

Owner: [evidence verifier](../../packages/mcp-test-lab/src/evidence.ts).

## Production conformance client

The official client exercises production config loading and the real MCP host's
list/call operations. Keep one production route rather than constructing a second
SDK client or issuing an unowned probe. Validate URL, revision and scenario
applicability before creating the runtime. Auth rejection requires the intended
resource/metadata exchange and natural process exit; a client that never starts
cannot prove the rejection.

[The shared descriptor](../../packages/assistant-contract/src/official-auth-conformance.ts)
owns supported scenarios, profile strategy, budgets and artifact destinations.
Expected-failure exceptions require explicit owner approval; never disable a
scenario or reinterpret a failure to obtain green. Raw auth output is captured,
bounded and sanitized, never inherited or placed in an evidence artifact.

Owner: [official client](../../apps/desktop/src/mcp/official-conformance-client.ts).

## Cleanup and process ownership

Every path closes its runtime, listener, sockets, OAuth state and subprocesses.
Timeouts, failed starts/exits and cleanup failures retain their original errors.
The runner reserves cleanup inside its existing deadline and emits no success
without settlement. Windows descendants share the kill-on-close Job Object;
POSIX groups are gone only when the kernel reports ESRCH. EPERM is inconclusive,
not proof of retirement. Preserve sibling groups until their wave settles and
surface unconfirmed cleanup without a process-enumeration fallback.

Owner: [official driver](../../scripts/run-official-mcp-client-conformance.mjs).
