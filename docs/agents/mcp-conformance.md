# MCP conformance

The [MCP test lab](../../packages/mcp-test-lab/src/) serves deterministic protocol fixtures to tests.

## Verification boundaries

- A passing lab fixture is not a claim about packaged desktop UX, live providers or upstream conformance.
  - The repository runs no official conformance suite and records no conformance evidence.
- The lab is Node-only and independent of production clients.
  - It reaches shared protocol shapes through the Tasks extension package and never enters an application dependency graph.
  - Desktop tests load its built `dist/`.
- The [scenario manifest](../../packages/mcp-test-lab/src/scenario.ts) owns fixtures, transports, negotiated revisions, capabilities and upstream provenance.
  - Profiles derived from upstream examples state their limited coverage.
  - Unknown scenarios or mismatched provenance fail visibly.
- Use isolated environments and lab-owned loopback listeners or subprocesses, never ambient credentials or the owner's configured servers.

## Cleanup

Owner: [session cleanup](../../packages/mcp-test-lab/src/session-cleanup.ts).

- Every session closes its listener, handler, sockets, OAuth state and subprocesses.
- Its cleanup report counts what closed and what OAuth state remains.
- A failed start keeps its original error. A failed close names only the resource kinds that failed, because resource errors can carry credentials, env or argv.
