# M3 persisted MCP approval: approved authority binding

Studio reproduced the independent review finding on unpublished work based on
`a07e08dc8ce0a0924e4e38df9344ccd0c6798581`. Two real local MCP servers expose the
same canonical probe schema. HostCore commits a pending approval for A through
the production platform and public Memory, closes its owners and SQLite writer,
then reopens the same root with the same configured name pointed at B. Approving
the original decision sends one `tools/call` to B. The regression requires zero
and fails with one; no retry or deadline change. Fixture setup failures remain
separate from this causal result. Receipt:
`/tmp/brainstrike-m3-mcp-restart-authority-reproduced.log`.

The bound identity is configured server ID, process-local generation and the
collector's canonical tool ID. Generations restart at 1. The run snapshot
contains no exact transport/configuration authority. `node-host-runtime` owns the
private configured definition, but its `configRef` is a process-local UUID.
Persisting that UUID would reject an unchanged server on every restart.

Existing Tasks authority epochs are durable and bind resource/principal, but
they exist only for servers advertising the Tasks extension. Legacy tools have
none. Stdio uses a reserved resource and local-process principal; changing its
command while the app is absent cannot be distinguished by those fields alone.
No complete existing durable cross-restart definition identity has been found.

Recommended owner decision: let the existing configured-server owner expose an
immutable, non-secret description of the selected authority, captured in the
existing run snapshot by HostCore. Compare the original capture before approving
or constructing the replacement executor. Cover canonical URL/transport,
protocol, stdio executable/args/cwd, authentication principal and relevant
extension configuration; never serialize credentials, environment secret values
or URL userinfo. Any private value whose change affects authority requires an
owner-approved comparison representation. Keep configured server/tool IDs and
the existing configuration writer; create no second configuration store or
backfill. Missing legacy captures refuse reconstruction explicitly.

Alternative: explicitly refuse every pending MCP approval after process restart
until the complete binding exists. This is safe only as an owner-approved
temporary loss of restart capability; it does not close M3 acceptance. Neither
option was implemented when this note was first written. Root AGENTS rule 1 requires owner approval
before a new durable identity/comparison representation or reconciliation design.

The separate private-port loss regression already fails before and passes after
bridge-owner cleanup. It proves executor abort, rejected progress, physical tail
join and selection release ordering over real MessagePorts. Cross-process Root
reuse after a crashed utility remains unqualified; a gone utility PID alone does
not prove a Main-side native tail has joined. Preserve that boundary in the
default lifecycle acceptance matrix.

CI is disabled due to cost; validation must run locally.

Owner approval received through parent dot at 06:13 UTC, 7 October 2026. Sean replied "you can proceed with the proposal" to the bundled questions for persisted MCP server binding and an isolated crash-lifetime prototype. Parent supplied the exact transcript; this is the explicit missing owner decision, superseding the prior pending state.

Approved MCP scope: the existing configured-server owner exposes a versioned immutable non-secret authority description captured in the existing run snapshot. Compare canonical destination/transport/protocol/executable/args/cwd and existing non-secret principal/credential record identity where available before reconstruction or approval. No passwords/tokens, secret-bearing environment/arguments, URL userinfo or hashed secrets. If an authority-affecting private field has no safe stable comparison, reconstruction refuses explicitly and the capability gap remains visible. No second writer/store, aliases or backfill. Acceptance requires unchanged configuration resumes, changed endpoint/command/principal refuses with zero effects, and missing legacy capture refuses visibly. Automatic review had rejected the parent's earlier proposed approval; this transcript provides the subsequently requested owner authorization.

## Implemented and demonstrated subset, 7 October 06:48 UTC

The configured-server owner now returns a deeply frozen version-1 description.
Core captures it in the existing run snapshot under admitted tool IDs. Both
desktop and Node adapter composition compare the original capture before
constructing a replacement binding. The transient generation/executor guard
still protects live calls. Refusals carry structured code
`mcp-authority-reconstruction-refused` and a reason for changed configuration,
missing legacy capture or unavailable private comparison.

The dedicated real MCP/SQLite restart suite passes **6/6**: changed HTTP
destination, unchanged unauthenticated HTTP, changed bearer record, private
headers, unchanged bearer record with unproved principal, and changed actual
stdio executable. The positive case executes one real `tools/call` after
reopen. The refusal cases execute zero replacement effects; both actual stdio
children physically exit. The unchanged bearer record is refused because its
ID cannot establish that an edited secret retained the same principal.
Private args/environment/headers, credential-bearing URL components and OAuth
principals remain explicit restart gaps; no secret is hashed or persisted for
comparison. The stdio fixture proves changed-command refusal, not an unchanged
stdio effect after restart.

The legacy proof projects an actual committed snapshot to its former shape and
checks the real admission boundary; it does not prove migration of an entire
legacy SQLite history. Combined with all preserved adapter cases: **27/27**,
**6.24 s**, `/tmp/brainstrike-m3-mcp-authority-principal-final.log`. Adjacent
configured-owner regressions: **37/37**, **3.66 s**. The first extended attempt
exposed a fixture session that could not reopen at the same URL; the fixture now
explicitly creates a fresh real SDK session after its old owner closes. Product
timeouts, retries and transport selection did not change.

These component receipts do not establish whole M3 acceptance. The latest normal
ordinary desktop case passes through reopen, but its OM counterpart crashes the
renderer during reload; the actual cause remains unproved. Crash-lifetime
production ownership still awaits the separately approved prototype/design
decision, and full local regression remains red.
