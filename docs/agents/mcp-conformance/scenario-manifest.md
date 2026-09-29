# Scenario manifest and fixtures — evidence

Supports `docs/agents/mcp-conformance.md` § "MCP verification harness"
(BST-1566, BST-1572, BST-1592, BST-1596). Read this before changing
`packages/mcp-test-lab/src/scenario.ts`, a fixture, a profile digest, or the
Tasks/Apps wire handling. The contract holds the rules; this is the record of
what each fixture is, where its bytes come from, and which pinned-SDK facts
forced the current shape.

## The harness and its scenarios, as landed

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
order, passes an explicit positive byte limit to the reader, and rejects an
artifact above that limit before hashing or decoding it.

## SDK 2.1 runtime alignment (2026-09-27)

`MCP_LAB_SDK_VERSION` records the installed client/server release, now 2.1.0.
The upstream fixture source remains the 2.0.0 tag and peeled commit above; its
profile bytes did not change. These are separate authorities: advancing the
runtime must not move historical fixture provenance to an unverified source.
The scenario test compares installed packages to the runtime declaration, the
built-package verifier checks both public entries, and valid evidence fixtures
obtain their SDK version from the closed scenario manifest.

The initial full lab unit run on SDK 2.1 failed because its runtime declaration
still named 2.0.0. The SDK split-package boundary guard also retains an explicit
lockstep assertion, now including `@modelcontextprotocol/core`. Fixture-advertised
`serverInfo.version: '2.0.0'` is the Brainstrike-owned fixture identity, not the
SDK package version, and remains unchanged.

## Bounded live provenance requests (2026-09-28, BST-1858)

Supports "Scenarios and fixtures". Electron qualification PR #3369 exposed
an existing live SDK-tag check using Vitest's default five-second limit:
[Test 36405992118](https://github.com/seandearnaley/brainstrike/actions/runs/36405992118)
failed only that integration case. The runtime, native package, four packaged
MCP lanes, both desktop smokes and the new collection guards passed. The failed
head is retained; it is not rerun to hide the defect.

An actual Git command delayed six seconds reproduces the old timeout. A first
prototype bounded the direct Git child, but a real Git process with a controlled
remote helper proved that both SIGKILL and default SIGTERM can leave the helper
alive. The owned probe helpers were explicitly cleaned up. That prototype is
not published and supplies no process-tree-cleanup claim.

The live checks now use GitHub's documented
[exact reference](https://docs.github.com/en/rest/git/refs#get-a-reference) and
[annotated tag](https://docs.github.com/en/rest/git/tags#get-a-tag) APIs with
the recommended JSON accept header and API version `2026-03-10`. Zod validates
unknown response bodies. The SDK ref must have the exact requested name and
point to a tag; the returned tag object's SHA and name bind back to that ref,
and its commit target must equal the unchanged historical pin. The ext-apps
ref must remain the exact lightweight tag pointing directly to its pinned
commit. No Git process or remote helper is spawned. Repository URLs still
come from the closed manifest and must have GitHub's HTTPS origin.

Each case shares one `AbortSignal.timeout(30_000)` through every request and
body read; Vitest gets 35 seconds including five seconds of assertion and
teardown headroom. The longest case has one ref plus four raw-source GETs,
all within the same deadline, not five independent 30-second allowances.
Four serial provenance cases have a 140-second failure ceiling; no package,
job, official-scenario or workflow timeout is raised. Tags, commit pins,
digests, document identity and profile anchors remain strict.

The final HTTP route accepts an actual first response delayed six seconds
(6,409 ms), while a 200 response with an unfinished JSON body fails visibly
at 30,012 ms with TimeoutError and confirmed signal propagation. Temporary
negative controls drive the actual test and reject wrong refs, wrong tag
types, malformed SHAs, wrong target commits, nested tags, wrong tag-object
SHAs/names, and HTTP 403 without additional requests or fallback.

There are three GitHub API requests per complete suite plus six raw-source
requests. Public unauthenticated reads use GitHub's
[60 requests per hour per IP limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
Rate-limit, malformed-response, missing-ref, digest and timeout errors stay
visible; the verifier adds no credential, cache, retry, skip or alternate
source. This is live fixture provenance, not official scenario execution or
packaged-product certification.
