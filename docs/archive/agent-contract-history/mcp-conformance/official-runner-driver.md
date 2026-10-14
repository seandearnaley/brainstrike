# Bounded official-runner driver — evidence

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness"
(BST-1560, BST-1576, BST-1583). Read this before changing
`scripts/run-official-mcp-client-conformance.mjs`, its wave structure, the
Electron preflight, or the sanitized diagnostics path. The contract holds the
rules; this is the record of the execution counts, the profile arithmetic, and
why child output is captured rather than inherited.

Correction (verified 2026-09-21): "Both root commands build the contract and
Desktop main bundle before running" describes a two-command era. There is now
one root command, `verify:mcp:official`, which builds
`@brainstrike/assistant-contract`, runs the Desktop prebuild and `build:main`,
and then dispatches whichever profile is selected.

## The driver, as landed

The bounded official-runner driver is
`scripts/run-official-mcp-client-conformance.mjs`. It validates the exact pinned
`@modelcontextprotocol/conformance@0.2.0-alpha.10` manifest and both exact empty
`{ "client": [] }` ledgers, then invokes the package's declared `dist/index.js`
through `process.execPath` and argv arrays rather than platform-specific
package-manager shims. The exact upstream alpha.10 CLI manifests expose fourteen
auth scenarios at `2025-11-25` and 25 at `2026-07-28`; that is upstream
availability, not the baseline execution count. BST-1560 runs its reviewed
fourteen-scenario production-auth profile once at each declared revision
(14 + 14 = 28) in exactly two parallel revision waves. The modern-closeout
profile owns the eleven additional scenarios that apply only at `2026-07-28`.
BST-1583 runs the complete applicable core
profile in two parallel revision waves: `initialize`, `tools_call`,
`elicitation-sep1034-client-defaults`, and `sse-retry` at `2025-11-25`; then
`tools_call`, `request-metadata`, `sep-2322-client-request-state`,
`http-standard-headers`, `http-custom-headers`, `http-invalid-tool-headers`, and
`json-schema-ref-no-deref` at `2026-07-28`. Its evidence is isolated at
`packages/mcp-test-lab/artifacts/official-core-evidence.json`, with the same
empty expected-failure ledgers and sanitized diagnostics as auth. The production
adapter and runner consume
one typed authority in `@brainstrike/assistant-contract`; Desktop consumes its
built subpath while repository scripts load its runtime-independent source; it
owns scenario manifests and each profile's evidence path, ticket, schema, execution strategy,
and timeout budget. The script test independently invokes alpha.10's `list`
command at both revisions, so the installed CLI remains the manifest oracle.
Both root commands build the contract and Desktop main bundle before running.
Before either protocol wave starts, the driver resolves Desktop's Electron
runtime once in the parent process and verifies the resulting absolute binary
path exists. This serial preflight owns Electron's lazy installation; scenario
children never race to extract into the shared package directory. A failed or
invalid provision aborts the command before any scenario is reported.

## Profiles, commands, and sanitized diagnostics

```bash
pnpm run verify:mcp:official
pnpm run verify:mcp:official -- --profile core
pnpm run verify:mcp:official -- --profile modern-closeout
```

BST-1576's closed modern profile is exactly the remaining eleven scenarios in one
`2026-07-28` wave, and sequential scenario process ownership. Sequential ownership
prevents one detached conformance process group's final reap from interfering with
another scenario while retaining the same per-scenario and outer Job Object bounds.
Every invocation uses
official single-scenario mode, a 30-second upstream timeout and a 45-second
outer deadline, so the official process's exit status is authoritative. The
driver never passes `--expected-failures` or auth `--output-dir`: alpha.10's raw
auth output can contain conformance context, token bodies and OAuth responses.
Child stdio is not inherited; it is captured through a bounded collector that
truncates only at line boundaries (so a dropped secret label can never leave an
unlabeled value behind), sanitized per line (ANSI stripped; URL queries, OAuth
parameters, and structured secret assignments redacted; 512-char line bound),
and printed to driver stderr as one bounded diagnostics block per failed
scenario — passing scenarios emit nothing. Results retain only fixed
revision/scenario ids, pass/fail status, timings, and a closed
start/timeout/cleanup/exit/runner failure discriminator; failure ids aggregate
once, and captured child output never enters the sanitized evidence artifact.
The conformance client process reports a sanitized bounded failure-cause chain
(including `AggregateError` members) for runtime failures; parse-phase failures
keep a fixed message because process input can carry credential-bearing auth
context.
