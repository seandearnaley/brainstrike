# M3 persisted MCP approval: owner decision required

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
option is implemented by this note. Root AGENTS rule 1 requires owner approval
before a new durable identity/comparison representation or reconciliation design.

The separate private-port loss regression already fails before and passes after
bridge-owner cleanup. It proves executor abort, rejected progress, physical tail
join and selection release ordering over real MessagePorts. Cross-process Root
reuse after a crashed utility remains unqualified; a gone utility PID alone does
not prove a Main-side native tail has joined. Preserve that boundary in the
default lifecycle acceptance matrix.

CI is disabled due to cost; validation must run locally.
