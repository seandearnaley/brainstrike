# MCP Tasks substrate — evidence

Supports `docs/agents/assistant-providers.md` § "MCP TRANSPORT SELECTION (CRITICAL)". The Tasks persistence substrate, lifecycle poll authority, interaction coordinator, and packaged verifier.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2482-2602); append rather than
rewrite.

---

Migrations 114-115 and `McpTaskRepository` provide the factory-reset-covered,
principal/resource/durable-authority-bound Tasks persistence substrate. This
matches the canonical Tasks contract that a task id is a durable handle and a
client must resume it after restart: [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)
and [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md).
The repository rebinds the live authority epoch across a Desktop runtime restart
instead of persisting the host's process-local generation. A same-runtime
generation advance rotates the epoch, and every write checks the exact live
epoch/runtime/generation lease in SQL. Because a rotated or retired epoch
orphans its non-terminal rows (`listActive` lists only the live epoch), the
generation must advance only when the server definition is replaced, never on
a transport reconnect, and `McpTaskLifecycle.stop()` retires the epoch only
for `server-removed` and `server-replaced`. A disconnect, restart, or close
leaves the epoch live so the next `openAuthority` rebinds it and `recover()`
resumes the handles; factory reset deletes the rows outright. Draining pollers
and in-flight creates never rejects; a failed retirement rejects `stop()`
without being memoized, so a later `stop()` retries it.

`McpTaskLifecycle` is the sole ordered `tasks/get` poll authority. It persists
each returned handle and its server timing before exposing it, registers
in-flight creates before their first await, resumes only the exact live
authority, and persists before publishing every update. Optional task
notifications carry no state into persistence or interaction: they only wake
and coalesce an immediate lifecycle poll. Interaction consumes the lifecycle's
post-persistence observation callback and never starts a second poll fleet.
Reset aborts and drains registered creates before the authority and task tables
are cleared, so a late insert cannot repopulate a fresh database. If PostgreSQL's canonical JSONB
representation exceeds the durable budget, the lifecycle persists the remote
status plus a bounded blocked diagnostic (field, exact byte count, limit, and
SHA-256) and no raw payload; it publishes neither the rejected remote state nor
an interaction event, so oversized input cannot trigger `tasks/update`. The row
is terminal to local recovery rather than remaining a false-green `working`
handle.
Server replacement, removal, disconnect, reset, restart, lifecycle close, and
caller cancellation abort timers, queued permits, and in-flight requests; a
late stale-authority response cannot publish. The poller rejects a mismatched
task id, terminally exposes the single canonical `maxTransportFailures`
transport-attempt budget, honors
changing `pollIntervalMs`, treats `ttlMs` as a lifetime backstop, and creates no
subscription lease. BST-1561 through BST-1565 built this as opt-in substrate;
BST-1566 registers it in production (see "Production Tasks host" below).

BST-1509 owns the Settings/diagnostics rendering of this matrix and modern
per-request wire proof; the registry remains its host-owned source of truth.

BST-1561 through BST-1563 are opt-in testable substrate only. The wire adapter requires exact
client and server `io.modelcontextprotocol/tasks` advertisement, routes all
three task methods with `Mcp-Name: params.taskId`, and owns one notification
lease per connection on both stdio and Streamable HTTP. The registry owns the
notification method/schema, refuses reserved core notification methods, and
releases the lease on local close, remote close, or rejected closure so retry is
possible. It never emits `tasks/list` or the deprecated request `task.ttl` field.
BST-1596 closes the acknowledgement gap: `listenForMcpTasks` reads the RAW
acknowledgement from the connection's dispatch ledger, not the core-stripped
`honoredFilter`, and a lease whose requested ids were not ALL honored closes
itself and rejects naming the rejected ids — an unacknowledged id can never emit,
so a partially or wholly unhonored lease must never look active. An
acknowledgement the bridge never observed, or one honoring ids outside the
request, rejects the same way; there is no zero-honored-ids success state left.
Real stdio and real Streamable HTTP wire tests cover full, partial, and empty
acknowledgements
(`packages/agent/src/__tests__/mcp-tasks-subscription-acknowledgement.integration.spec.ts`).
These wire fixtures and the modern stdio extension suite await cleanup in reverse
acquisition order: the client must finish closing before its request-log directory
is removed. Cleanup continues after a failure, preserving a sole original error
or aggregating every failure in disposal order.
Production registration is the BST-1566 layer below.

BST-1564 adds the opt-in interaction coordinator without enabling Tasks in production. It deduplicates
task-scoped input keys and sends elicitation results through `tasks/update` only after shared MCP
validation with exact server, resource, principal, generation, task, and input-key provenance.
`McpTaskLifecycle` is the sole ordered polling authority: it validates exact task identity, persists the
observation, and only then publishes it through the neutral task-observation port. The interaction
coordinator consumes that published stream and never starts a poller. `recover()` is idempotent for
tasks the lifecycle already polls: an active durable record whose id is already tracked is returned
as its existing tracked entry (same `settled` promise) rather than started again, while `start()`
stays strict so one poller per task holds; the desktop host mirrors this by reusing its registered
entry on the card-driven `recover` action. Optional notifications for the
acknowledged ID subset only coalesce an immediate lifecycle poll; lease loss does not disable polling.
Transport exhaustion rejects the public tracked-task settlement and is published to the interaction
failure surface. A `tasks/cancel` acknowledgement is not success: only observed `cancelled` settles
successfully; `completed` or `failed` is a non-cancellation outcome. Each observation treats
`inputRequests` as the complete outstanding snapshot and retires omitted keys before stale responses
can be sent. Task responses keep the merged BST-1561 discriminator ruling (an absent `resultType` is `complete` per final SEP-2322; a conflicting value is rejected). Terminal state, generation replacement, and coordinator close abort pending input and
release resources. Sampling/roots task input remains unsupported (an
`input_required` request with any method other than `elicitation/create`
throws); renderer UX, host registration, and support advertisement are the
BST-1565/BST-1566 layers.

BST-1565's first layer adds an opt-in presentation and control fence; it does
not register Tasks. The browser-safe contract carries one opaque exact handle
(server, resource, principal, generation, and task), status copy, and only the
newest eight of the repository's 32 transition entries. Input/result metadata
never crosses that seam. The separate model projection omits the complete
control identity and is capped at 2,048 serialized UTF-8 bytes, with explicit
truncation. Every recovery or cancellation click revalidates protocol
`2026-07-28`, capability presence, principal, server/resource, and generation
both before and after the owning authority runs. Failures use stable
`stale_handle`, `lost_principal`, `unsupported_version`, and
`capability_removed` diagnostics. The injected authority remains responsible
for atomic repository/lifecycle/interaction fencing; the presentation module
cannot create a task, turn a task handle into synchronous tool completion, or
enable support advertisement.

The final BST-1565 verifier is a test-only lazy renderer mode guarded by both
`mode=mcp-task-harness` and Desktop test mode; a production launch cannot enter
it, and the harness chunk itself exists only in a renderer built with
`VITE_MCP_TASK_HARNESS=1` (the packaged verifier lane,
`test:e2e:lane:packaged-mcp-tasks`, packages with it; release builds never do),
so the harness, its PGlite and migration closure never ship to users. In a
genuinely packaged Electron binary it opens the shared-factory PGlite store
(full engine-extension set) migrated by the real `MigrationRunner` over the
full migration list, a durable authority lease, and the real repository. The first process
persists a lifecycle-owned handle and closes cleanly; a second process over the
same isolated user-data directory rebuilds `restart_required`, recovers through
`McpTaskLifecycle`, and cancels only after `McpTaskInteraction` observes remote
`cancelled`. The packaged proof also exercises lost-principal and stale-
generation refusal, focus behavior, and zero lifecycle polls/tasks/timers,
interaction operations/listeners, and database ownership after explicit close.
This verifier is not a production host adapter; production registration is
`McpDesktopTaskHost`, below, which must never import the harness.
