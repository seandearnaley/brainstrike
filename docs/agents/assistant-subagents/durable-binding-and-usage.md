# Durable binding, publication boundary and delegated usage — evidence

Supports `docs/agents/assistant-subagents.md` § "Durable binding before publication and resume preparation".
Supports `docs/agents/assistant-subagents.md` § "Host binding adapter".
Supports `docs/agents/assistant-subagents.md` § "Native run publication boundary".
Supports `docs/agents/assistant-subagents.md` § "Durable delegated usage".

The BST-1718 storage/publication layer: graph writes before the first forwarded child event, `bindRun` authorization, and migration 128 usage attribution.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 853–988 at commit 7c3eb8f38.

---

The native contract fixture now awaits a real delegated graph write in the child
input processor and reloads that binding through a new repository before every
forwarded child event, including `start`. Public `Memory.getThreadById` confirms
that the native thread already exists at this seam, with both explicit and
inherited child memory. This proves the storage prerequisite, not production
host wiring or invocation/run attribution.

The recreated-agent grandchild approval and decline cases also prove that the
child input processor is not invoked on snapshot resume. A production resume
must authorize persisted ancestry and invocation identity at the host boundary
before forwarding any resumed child event; rerunning the input processor cannot
be assumed. See the current [processor interface timing](https://mastra.ai/reference/processors/processor-interface).

### Host binding adapter (BST-1718)

The direct `MastraAgentRuntimeOptions.conversationBinding` capability is threaded
through persona construction and the native delegation policy. The policy first
checks persona availability and budgets, then snapshots its configuration and
clamped maxSteps. Each child input processor awaits the capability's persistence
callback before model/tool execution. Missing parent registration or a rejected
write fails the child visibly. The callback receives observed native parent run,
thread/resource, parent tool-call, persona and actual child thread/resource ids;
it does not receive a fabricated child run id before native streaming exposes it.

The adapter stores ephemeral correlation in a WeakMap, not RequestContext entries
or RuntimeData. Its configuration snapshot is cloned before child execution.
The real production stream fixture proves callback-before-tool ordering and zero
child tool executions on persistence rejection. Removing the persona processor
wiring makes both regression cases fail. Existing read-only/no-recursion gating
is preserved. Desktop run-scoped memory now installs this capability through
`getDesktopMastraMemory` and the shared service runtime options. The host derives
owner, root and turn from its persisted server run; child resource ids remain
native execution scopes. Resume reauthorizes the original invocation against the
current leg's owner/root/turn. Names and colors are allocated once in the graph.
Thread deletion expands the complete native branch through the same authorized
graph (single, bulk and native Memory paths); revoked ancestry rejects the whole
delete, and overlapping bulk roots produce one deletion per native thread.

### Native run publication boundary (BST-1718)

A host may additionally supply `conversationBinding.bindRun`. The shared
`streamAttemptChunks` path awaits it before mapping the first native child
`tool-output` event in each attempt, including approval and suspension resume
legs. It receives the observed native parent run/tool call, child run and persona;
the host must resolve and authorize the durable invocation before returning.
The guard caches only successful bindings for that attempt and rejects a changed
child run under the same parent call. A recreated resume therefore authorizes
again, even though Mastra skips child `processInput` and may omit a new start.
No database lookup is performed for every text/reasoning delta.

Desktop now activates this boundary; child transcript/UI routing remains
BST-1719/BST-1724. The parent delegation-tool start can still render before native child
progress exists. A rejected publication binding propagates through the existing
stream error/abort path; cooperative abort is not proof that every asynchronous
native memory write has settled. The failure-path publication test uses Mastra's
public InMemoryStore; database durability remains separately proven with real
PGlite. Do not close a live host database merely because iteration rejected.
Paired production-stream tests cover awaited binding, single binding per attempt
and visible rejection without child progress; real recreated native approval
and decline tests prove the guard sees the same persisted native run identity.

The repository's `bindInvocationRun` includes the observed persona in its atomic
SQL predicate, both on first publication and reauthorization. A separate host
read cannot substitute for that mutation-time check. Missing/changed native identities remain fatal to
publication, rather than being skipped and potentially forwarded as authorized.
A real native child-tool failure retains its native chunk identity and is covered
by the production-stream guard test. With no `bindRun` capability, the guard is
absent and the stream loop adds no authorization promise/microtask per chunk.

### Durable delegated usage (BST-1718)

Bound completion reports carry the public Mastra parent run/tool call and child
thread/resource ids. The existing desktop child-usage writer resolves these to
the authorized, published invocation and its original host leg. Migration 128
adds a nullable invocation join to the existing usage table; historical rows are
left unattributed. Duplicate reports and cumulative resumed totals update one
row with monotonic token maxima, never additive replay. Model/provider cannot
change on that row. The public output-step processor reports actual model usage
before tools can pause or be cancelled. Installed Mastra supplies prior completed
`steps` separately from current `usage`; their sum is the cumulative invocation
total, including across approval resumes. Missing counts do not fabricate rows.
Metering uses a `transient: true` custom data part, so it cannot replace the native
assistant message or alter its tool output, text, or parent outcome. The public
native data-part path forwards these frames without delegation wrapper metadata;
the projection requires one already published active child thread and derives
its observed parent identity before the durable writer rechecks resource ownership.
The real desktop runtime tests preserve 1/1 tokens on pause/Stop and 2/2 after an
approved second model response, with artifact hydration and completed parent
outcomes verified through the same native boundary.

The completion hook can run ahead of a slow stream consumer. Bound reports stay
queued until the matching parent result/error or finish, after native child
publication has authorized its run. In-stream progress reports can drain only
after that same published child identity is validated. Completion and progress
reports coalesce by invocation and never replay unchanged cumulative totals.
Empty queues return before decoding a part.
Final draining still requires the durable binding at the writer; missing/changed identity or a failed write propagates
before the transient usage refresh. The writer uses the existing run-critical
foreground scheduler and its narrowly diagnosed saturated-host recovery. An
exhausted write fails visibly with a coded log; it never silently drops billing.
Identity errors carry a reason identifying the failed boundary without guessing
which SQL ownership predicate failed. Unbound callers retain their existing
usage contract. Local unbilled calls do not create billing rows.

The scripted model fixture is exported through the existing agent test-fixture
subpath convention (`@brainstrike/agent/test-fixtures/scripted-agent-model`), so
cross-package tests never import private source paths.
`delegated-runtime.integration.test.ts` drives desktop memory, the real Mastra
loop and the existing usage writer with only model transport/DB handle injection
scripted. It forces a fast child ahead of the consumer and reconstructs a PGlite
engine to verify durable identity/usage. This is host integration evidence, not
packaged Electron E2E or a process-restart guarantee. The separate graph/host,
branch deletion, contract and stream-ordering tests cover rejection and replay.

Lifecycle stays in the existing `brainstrike_assistant_run_events` journal.
Native delegation start/finish/failure events now carry `parentRuntimeRunId`
alongside `parentToolCallId`, so the host run/root ownership plus this key joins
the exact invocation, including repeated tool-call names in different runs.
Legacy events lacking the key are not fabricated into child lifecycle history.
The desktop production-loop test verifies this durable terminal correlation.
Neither root nor child conversations currently expose an archive action.
Child navigation inherits root filter/folder visibility (BST-1725); closing a
child tab remains reversible and does not delete or stop its work. There is
no automatic invocation retention sweep. Host-run retention must preserve
resumable invocations or explicitly remove the complete branch. Dedicated child
transcript statuses, approval presentation and lifecycle controls remain in
BST-1719/1720/1723 as specified by their contracts.

Deleting a delegated conversation detaches its usage row's delegation keys while
retaining the surviving root's spent tokens and cost. Numeric usage history was
already excluded from native thread-delete sidecars and also survives root
conversation deletion; factory reset remains its explicit cleanup path. Resource
re-keying is not a supported mutation of this immutable graph: an owner/scope
mismatch must remain denied. A future ownership migration must update native
and graph identity atomically with its own recovery proof, never bypass this
authorization check to delete a partially re-keyed branch.
