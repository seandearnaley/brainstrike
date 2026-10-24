# MCP conformance

Use this contract when changing the MCP test lab. The lab serves deterministic
protocol fixtures to tests; it does not establish packaged desktop UX,
live-provider acceptance or upstream conformance. Local validation and CI
authorization belong to `pnpm check`.

## Verification boundaries

[The MCP test lab](../../packages/mcp-test-lab/src/) is Node-only and independent
of production clients. It reaches shared protocol shapes through the Tasks
extension package and must not enter an application dependency graph. Desktop
tests load its built `dist/`.

The scenario manifest owns executable fixtures, transports, negotiated revisions,
capabilities and upstream provenance. Profiles derived from upstream examples
must identify their limited coverage rather than claim complete upstream
conformance. Unknown scenarios or mismatched provenance fail visibly. Use
explicit isolated environments and lab-owned loopback listeners or subprocesses,
not ambient credentials or an owner's configured servers.

The repository runs no official conformance suite and records no conformance
evidence. A passing lab fixture is not a claim about the upstream suite.

Owner: [scenarios](../../packages/mcp-test-lab/src/scenario.ts).

## Cleanup and process ownership

Every session closes its listener, handler, sockets, OAuth state and
subprocesses. Its cleanup report counts what closed and what OAuth state
remains. A failed start keeps its original error; a failed close names only the
resource kinds that failed, because resource errors can carry credentials, env
or argv.

Owner: [session cleanup](../../packages/mcp-test-lab/src/session-cleanup.ts).
