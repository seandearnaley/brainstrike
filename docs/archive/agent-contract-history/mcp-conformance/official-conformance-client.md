# Production official-conformance client — evidence

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness"
(BST-1560, BST-1583). Read this before changing
`apps/desktop/src/mcp/official-conformance-client.ts`, a scenario set, or the
expected-failure ledgers. The contract holds the rules; this is the record of
which scenario applies at which revision and why each is driven the way it is.

Correction (verified 2026-09-21): the closing sentence below defers
"per-scenario result accounting, expected-failure consumption, and CI ownership"
to BST-1560 as future work. That work has landed — `mcp-verification.yml` runs
the three official jobs and `buildOfficialAuthEvidence` emits the accounting —
so the contract no longer carries the deferral.

## The expected-failure policy and the client, as landed

Official client-conformance expected-failure policy is separate from scenario
provenance and does not imply that the official runner executed. The dedicated
`packages/mcp-test-lab/conformance/expected-failures/` directory contains
exactly `2025-11-25.json` and `2026-07-28.json`; both use the closed
`{ "client": string[] }` shape and remain empty for a truthful zero-failure
release claim. Adding an accepted failure requires a reviewed contract change
and its explicit Linear blocker in the later official-result evidence layer.

The production conformance client entry lives in
`apps/desktop/src/mcp/official-conformance-client.ts`. It accepts only a
validated server URL, exact `2025-11-25` or `2026-07-28` protocol revision, and
the closed non-auth set: `initialize`, `tools_call`,
`elicitation-sep1034-client-defaults`, `sse-retry`, `request-metadata`,
`sep-2322-client-request-state`, `http-standard-headers`,
`http-custom-headers`, `http-invalid-tool-headers`, and
`json-schema-ref-no-deref`; plus the exact fourteen-name alpha.10 auth baseline
in upstream order and the exact eleven-name modern auth closeout. The six new
non-auth scenarios and the eleven
resource, offline-access, authorization-server migration, authorization-response
issuer, and metadata-issuer scenarios are accepted only at `2026-07-28`; the
client schema rejects a fabricated `2025-11-25` pairing before runtime creation.
`elicitation-sep1034-client-defaults` and `sse-retry` are accepted only at
`2025-11-25`, matching their alpha.10 applicability window, while `tools_call`
is valid at either declared revision. It builds configuration
through the production loader, creates a fresh `DesktopMcpHostRuntime`, and
drives list/call through `McpHostPort`; it never constructs a parallel SDK
client. Legacy runs select explicit `legacy`, modern runs pin `2026-07-28`, and
`initialize` is accepted only at its canonical legacy revision. Unknown or
inapplicable scenarios fail rather than falling back. The elicitation adapter
accepts with empty content and explicitly advertises SDK-owned primitive
default application; SSE retry remains owned by the production HTTP transport.
The metadata scenario performs the production connect lifecycle without an
unowned probe request. The MRTR scenario invokes the four upstream tools through
the production capability engine, including the absent-`resultType` compatibility
case. Standard-header coverage drives tools, resources, and prompts through the
ordinary host port; custom-header coverage accepts only the exact upstream
two-call context; invalid-header coverage calls only the surviving valid tool;
and JSON Schema reference coverage lists tools without dereferencing network
references.
Auth runs use `oauth-user` plus `authentication-required`, an ephemeral store,
the canonical CIMD client URL only for `auth/basic-cimd`, and exact context
rules: thirteen scenarios require no context while `auth/pre-registration`
requires its strict client-id/client-secret context. The headless opener accepts
only an HTTP `localhost` or `127.0.0.1` authorization endpoint and one exact
`127.0.0.1` `/mcp/oauth/callback` redirect, disables automatic redirects,
rejects malformed, foreign, missing, or duplicate callback data, and emits fixed
diagnostics.
The alpha.10 auth fixtures expose the common `test-tool` after authorization;
all scenarios except `auth/pre-registration` must invoke it. Pre-registration
instead proves the supplied client credentials through the authenticated
connect and subsequent tools/list because its upstream scenario does not own a
common-tool assertion.
Every run closes the host, clears ephemeral OAuth state, and rejects a non-empty
cleanup-failure report. Exhaustive per-scenario result accounting,
expected-failure consumption, and CI ownership remain BST-1560.
