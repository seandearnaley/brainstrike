# MCP conformance and verification contract

Owner of the MCP verification harness (`@brainstrike/mcp-test-lab`), the
production official-conformance client, the bounded official-runner driver, the
evidence schemas, and the durable official conformance evidence links. It was
split out of `docs/agents/assistant-providers.md` under BST-1590 so that every
conformance landing stops rewriting the provider contract; CI trigger shape,
budgets, and the red-`main` exit condition stay in `docs/agents/ci-quality.md`.
Update this document and `scripts/__tests__/mcp-verification-ci-contract.test.mjs`
in the same change.

## MCP verification harness

`@brainstrike/mcp-test-lab` is a Node-only, production-independent verifier
boundary. It is not a production MCP client and must not enter application
dependency graphs. The package owns a closed scenario manifest: scenario ids,
fixture identities, protocol-era/revision pairs, and exact official
SDK/conformance provenance are explicit and independently testable. Unknown
scenario ids fail visibly, and every manifest records that it consumes no
ambient credentials. `modern-reference` and `legacy-reference` have
`availability: 'executable'`. The modern scenario is a bounded, source-backed
profile of the official SDK v2 `test/conformance/src/everythingServer.ts` at
tag `@modelcontextprotocol/server@2.0.0`, peeled commit
`cc4b41617ce3601b1290d67216ea0b194a3cd9ac`, and source SHA-256
`3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852`.
The executable, behavior-defining data lives separately in
`official-everything-profile.ts`; evidence records and binds both that local
profile digest and the upstream source pin. A live integration test verifies
the upstream bytes and every profile anchor. It exercises the official tool,
resource, prompt, completion, and modern subscription capability shape without
claiming to vendor or run the full upstream conformance server.
The legacy scenario retains the Brainstrike-owned SDK v2 echo fixture, which
since BST-1592 also serves one resource, one `completable()`-argument prompt,
and therefore `completion/complete` (`ECHO_REFERENCE_CONTENT` in
`reference-server.ts`) so the packaged content proof runs against a
Brainstrike-owned fixture rather than the pinned official profile. Negotiated
capabilities are pinned per FIXTURE by `mcpEvidenceCapabilitiesFor`
(`evidence-schema.ts`): the HTTP echo fixtures and the official profile
negotiate `completions`/`prompts`/`resources`/`tools`, while the separate
spawned stdio echo fixture still negotiates `tools` only. Both
use focused real client exchanges over in-process and ephemeral loopback HTTP.
Loopback listeners bind only `127.0.0.1` on an
ephemeral port, apply the SDK localhost Host/Origin validators, and close before
the session reports completion. `stdio-reference` is also executable through
one lab-owned spawned child with an explicit empty environment; stderr is
retained only as a byte count, and close proves the child is gone.
`oauth-reference` is executable only over an ephemeral loopback listener. It
publishes authorization-server and RFC 9728 protected-resource metadata, accepts
bounded native-public-client registration, binds one-shot authorization codes to
S256 PKCE and the RFC 8707 resource, emits and verifies the RFC 9207 issuer, and
protects the real SDK v2 MCP handler with bearer authentication. Callback state
and issuer verification is one-shot, route state is bounded, and close reports
token-free zero counts for clients, states, codes, and tokens after clearing them.
`tasks-reference` is the executable Tasks-extension release proof (BST-1566,
SEP-2663 revision 2026-07-28). The pinned upstream tree ships no executable
Tasks conformance suite and its core still registers the pre-revision Tasks
shape, so the scenario is a Brainstrike-owned schema-derived profile
(`tasks-profile.ts`) whose evidence carries partial upstream provenance to the
pinned SDK `packages/core/src/schemas.ts` and must not claim full upstream
coverage. The lab-owned reference server is driven by that profile: one tool
returns a `task` result; the observable timeline is `working`,
`input_required` (one elicitation input request), `completed`; input is
delivered through `tasks/update` and validated against the profile's exact
expected response; task timestamps are profile-driven and deterministic, so
identical runs expose identical wire behaviour; a second task proves
`tasks/cancel`;
unknown task ids are rejected (RED); every transition emits the optional
`notifications/tasks` status notification on the stream of the request that
caused it (`relatedRequestId`). Every response is parsed with the extension
package's own parsers; `@brainstrike/mcp-tasks-extension` is a pure protocol
contract (pinned schemas and parsers, SDK core and zod only) and is classed as
`shared-foundation` in `architecture/domain-map.json` precisely so the
production-independent verifier may consume it without importing production
client code. The pinned server's `subscriptions/listen` bus models
only the four spec change events and cannot honor a `taskIds` filter, so a
pinned-SDK server can never push task status to a listen lease. Since BST-1596
the production client REJECTS such a lease (it closes and throws naming the
unacknowledged ids) instead of returning a zero-honored-ids lease, because the
raw acknowledgement — not the SDK's core-stripped `honoredFilter` — is now the
source of truth. Against a pinned-SDK server that is the expected outcome and
not a Brainstrike defect: polling stays the authoritative lifecycle path and the
coordinator records the lease failure visibly. Two pinned-SDK facts shape the harness and are
recorded here so nobody relitigates them: the pinned core physically deletes
`tasks/get`/`tasks/cancel` from the 2026-07-28 wire codec on BOTH ends and its
response funnel admits only `complete`/`input_required` result types, so the
lab uses the same closed transport-boundary alias bridge the production client
uses (`tasks-wire-alias.ts`: the SDK sees non-colliding consumer methods and
`complete` results; only the wire carries the official shape); and the pinned
server lifts the reserved retry-channel names `inputResponses`/`requestState`
off every client request's params onto the handler context, which is where a
`tasks/update` handler must read them. The modern handler allocates a server
per request, so the Tasks fixture shares one task store per handler through
`createReferenceServerFactory`.

`apps-reference` is the executable MCP Apps interoperability proof (BST-1572,
`io.modelcontextprotocol/ui`). The pinned official example server is
`examples/basic-server-vanillajs` at ext-apps tag `v1.7.5` (a lightweight tag:
commit `92f46a574568a3ddac7600343b7d3c4c4ed7b588`); its npm package ships only
`dist`, so the scenario is a Brainstrike-owned derived profile
(`apps-profile.ts`) whose evidence carries `official-ext-apps` upstream
provenance to `server.ts` and whose live provenance test verifies all three
example files by digest (server.ts, main.ts, mcp-app.html) and every profile
anchor. The lab-owned reference server registers the example's app tool with
BOTH resource-URI metadata keys the pinned `registerAppTool` writes
(`_meta.ui.resourceUri` and `_meta["ui/resourceUri"]`) and serves the exact
pinned document as the linked `ui://` resource with the MCP Apps MIME profile,
without importing the ext-apps package. Capability negotiation is part of the
proof: the verifier client advertises the `io.modelcontextprotocol/ui` host
capability with the MCP Apps MIME profile, and the fixture serves the app
document only to a client that did (an integration test proves a generic
client, or one advertising another MIME type, is rejected). GREEN/verification
prove listing, linkage, MIME, byte-exact read, and the structured tool output;
RED proves a missing `ui://` resource is rejected. Rendering through the packaged Electron
host, sanitized manual CDT evidence, SECURITY.md/support-matrix changes, and
production registration remain owner-gated and are not claimed here.

The private artifact-integrity core reads each unique reference once and in
order, passes an explicit positive byte limit to the reader, rejects an
oversized result, and copies Buffer, shared, or reader-owned bytes before
SHA-256 and extraction. Text decoding is fatal UTF-8; screenshots require
separate rendered-text and metadata extractors, and both outputs are scanned.
Dependency failures expose only bounded error codes,
never artifact content. It remains non-public behind the immutable facade.

The `./evidence` verifier accepts a closed exact-head schema, binds RED, GREEN,
and verification commands, reads each unique artifact exactly once, hashes the
original bytes, decodes text with fatal UTF-8 handling, and requires explicit
screenshot text plus metadata extraction. Before returning, it sanitizes schema metadata and
every extracted artifact without trusting the schema's `sanitized` assertion.
Schema metadata is sanitized before artifact dependency I/O, so credential-bearing
references cannot reach readers or integrity-error diagnostics.
The private scanner detects explicit credential assignments and credential
formats, then applies bounded HTML-entity and structured JSON decoding to catch
nested, escaped, prefixed, multiline, percent-encoded, and screenshot-extracted
credentials. Text, node, candidate, decoding-depth, and embedded-work budgets
are cumulative across the bundle and fail closed. Each artifact is read once,
hashed, extracted once, and sanitized before the next artifact begins, so a
dirty artifact stops later readers and extractors. It returns only a detached,
deeply frozen bundle. Reader, extractor, and sanitization failures use bounded
diagnostics that never reflect artifact content. Raw scanners, sanitizer
sessions, and decoders remain private implementation details; only the safe
error class and issue metadata are public.

Evidence schema `1.1.0` makes desktop applicability explicit instead of
interpreting an absent field. Protocol-lab-only runs record the closed
`{ required: false, reason: 'protocol-lab-only' }` arm. Desktop-required runs
must name the isolated agent-debug profile, fixed app identity, loopback CDT
origin and inspected renderer, a green Electron E2E command, and every id in
the prescribed Settings/OAuth/assistant/cancel/restart/config/concurrency/
disconnect matrix. Each matrix result points at one or more declared artifacts;
blocked rows name a top-level blocker. At least one screenshot plus one durable
log or trace is required, and the successful secret-scan claim must cover every
artifact exactly once. The verifier still scans all metadata and extracted
artifact content itself before dependency I/O, including credential-bearing
redirect URLs, authorization codes, PKCE verifiers, bearer values, and secrets.
The versions block also carries a closed fixture-provenance arm: Brainstrike
fixtures name their repository path, while the derived official modern profile
records its local executable profile digest separately from its upstream
repository, path, peeled commit, and source digest. Scenario id, protocol,
capabilities, SDK/conformance versions, and fixture provenance must match the
closed scenario manifest exactly.

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

## Official conformance evidence (BST-1589)

The first complete green official auth dispatch was
[run 33541373505](https://github.com/seandearnaley/brainstrike/actions/runs/33541373505):
28/28 baseline auth and 11/11 modern auth closeout, with zero expected failures.
The same matrices then passed twice at merged-main commit
`f76ec5149fa435a541eca2c56e42be02da6d7e32` in
[run 33545728828](https://github.com/seandearnaley/brainstrike/actions/runs/33545728828)
and
[run 33545945643](https://github.com/seandearnaley/brainstrike/actions/runs/33545945643).
These links are the durable run evidence; counts copied into prose do not replace
the exact-head workflow and its sanitized artifacts. This is protocol-lab proof,
not packaged Electron or live-provider acceptance evidence.

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

The baseline driver writes one atomic, mode-0600
`packages/mcp-test-lab/artifacts/official-auth-evidence.json` file; the modern
closeout writes only
`packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json`.
The baseline preserves BST-1560 schema `1.0.0` exactly and has no `profile` field;
the modern artifact uses schema `1.1.0` and records
`profile: "modern-closeout"`. Both bind their owning ticket, exact Git head and
clean/dirty state, verified empty ledgers, wave timings, fixed result ids, cleanup
status, and the explicit `{ prerelease: true, required: true }` conformance
classification. `required` records the project's gate posture (the official
jobs carry no `continue-on-error`; `mcp-verification-ci-contract.test.mjs`
pins the field to that absence), not whether a given run happened in CI, so a
local `pnpm run verify:mcp:official` writes the same value. No raw auth
artifact directory exists. On Windows (BST-1557, a bounded child of the
BST-1472 verifier project), the outer driver loads the existing
`@brainstrike/windows-job-native` capability from Desktop and assigns itself to
its kill-on-close Job Object before the first scenario spawn.
Every child inherits that owner. Per-invocation cleanup remains isolated on
POSIX. Sequential Windows runs clean each scenario's descendants before starting
the next; parallel baseline runs defer cleanup until all siblings in a revision
wave settle so one scenario cannot terminate another. Authoritative Job membership
is then checked and remaining descendants are terminated. Timeout, failed start, failed exit
and cleanup failure remain visible;
there is no process-enumeration fallback. The bundled desktop process entry
accepts only the exact auth context rules above and otherwise emits one fixed
stderr line. The official package is prerelease, and the evidence records it as
such; since BST-1582 the three official conformance jobs are nonetheless
required post-merge gates: they run on every push to `main` (plus the nightly
schedule and manual dispatch), a failing scenario fails the workflow and turns
`main` red, and — because they run after the merge — they detect regressions
rather than block them. `docs/agents/ci-quality.md` owns the trigger shape,
budget, and exit condition.

The modern workflow step has a ten-minute timeout: eleven sequential 45-second
deadlines consume at most 495 seconds, leaving 105 seconds for runner setup,
cleanup, and evidence persistence. Its 21-minute required job also reserves four
minutes for the build, three for the bounded Electron provisioning step, and
four for workflow setup/upload. Contract tests compare
these values to the shared descriptor; per-scenario deadlines are not shortened.

Add verifier capabilities incrementally. A package export may appear only in
the layer that implements and independently tests it; do not advertise a
transport, fault coordinate, OAuth route, evidence guarantee, or runner before
that branch contains its executable path and focused verifier. The private
runner manifest owns two closed deterministic profiles over ten case ids:

- `pr`: 6 cases, 10,000 ms per case, 90,000 ms per run — modern in-process
  HTTP, legacy loopback HTTP, OAuth loopback HTTP, modern stdio, modern Tasks
  in-process HTTP, and modern Apps in-process HTTP.
- `exhaustive`: 10 cases, 20,000 ms per case, 270,000 ms per run — the PR set
  plus modern loopback, legacy in-process HTTP, modern Tasks loopback HTTP, and
  modern Apps loopback HTTP.

Selection accepts only `profile`, `caseIds`, `caseTimeoutMs`, and
`runTimeoutMs`; unknown fields, duplicate/foreign case ids, and out-of-bound
timeouts fail visibly. Omitted optional fields use the profile defaults.
Explicit `undefined` values are malformed and never treated as omission. An
explicit selection cannot exceed its closed profile, a case timeout stays
within 100–60,000 ms, and a run timeout stays within 100–600,000 ms without
falling below its case timeout. Case limits are per-case ceilings, not reserved
runtime, so the whole-run ceiling need not equal their sum; it does stay above
that sum so a merely slow sequential run fails per case, not as a run timeout.
The `./runner` owner executes closed profile selections serially as genuine RED, GREEN, and
repeat-verification phases. Every phase receives a bounded abort signal and an
independently bounded cleanup attempt; a primary plus cleanup failure remains
an `AggregateError`, while any missing cleanup proof prevents evidence emission.
The whole-run deadline can shorten a case budget but never silently expands one; phase
observations agree with the canonical scenario era/revision and stable
capability set before the existing evidence sanitizer and artifact-integrity verifier can return a
deeply frozen bundle. Current public verifier subpaths:
`./evidence`, `./faults`, `./lab`, `./runner`, `./scenario`.

The package CLI derives exact Git identity and dirty or clean workspace state;
those values are not caller arguments. The package CLI fixes the evidence ticket
to `BST-1486`; the repository wrapper rejects a GitHub Actions checkout whose `GITHUB_SHA` differs from
`HEAD` or whose tracked/untracked state is dirty before the run. The PR-required
representative command is `pnpm run verify:mcp -- --profile pr --output artifacts/pr-evidence.json`.
The exhaustive schedule/manual command is `pnpm run verify:mcp -- --profile exhaustive --output artifacts/exhaustive-evidence.json`.
Both reach the same package CLI and emit atomically verified, credential-free
JSON below the ignored `packages/mcp-test-lab/artifacts/` directory.
