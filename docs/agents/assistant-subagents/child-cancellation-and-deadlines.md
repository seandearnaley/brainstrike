# Deadlines, downstream usage failure and selected cancellation — evidence

Supports `docs/agents/assistant-subagents.md` § "Background child deadlines".
Supports `docs/agents/assistant-subagents.md` § "Downstream usage failure and cancelled child projections".
Supports `docs/agents/assistant-subagents.md` § "Selected child cancellation".

Executor deadline signals, the cancelled-child reconciliation on a failed usage write, and `POST /assistant/cancel-child`.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 2614–2717 at commit 7c3eb8f38.

---

A background executor that resolves after its native task signal aborted must
reject before native outcome classification. Mastra 1.64 otherwise marks the
empty delegation result completed. The existing delegation tool hooks capture
the executor signal by native parent run/tool-call identity and check it after
execution; the host-owned resumed executor applies the same check. No timer,
retry, native task-state override or dependency patch is introduced.

Child projection reads that execution signal separately from explicit selected
cancellation authority. An expired execution produces one failed child terminal
with the native abort reason; selected Stop remains cancelled. Signal ownership
survives queued output and is replaced on the next admitted execution of the
invocation. Rejected duplicate preparation preserves the active deadline signal.
Host resume capture also stages the signal by parent thread/tool call so native
preparation retains that execution's deadline.
`delegated-deadlines.integration.test.ts` pins native timed_out, durable failed,
exact terminal events and a concurrent sibling continuing to completion; the
approval-resume case also checks persisted usage and reload. This does not
resolve the separate usage-binding-conflict whose rejected tuple is missing.

### Downstream usage failure and cancelled child projections (BST-1771)

A rejected bound usage write closes the upstream iterator: its cleanup joins
native background cancellation, but its catch and remaining streamed terminal
parts cannot reach the event observer. The root failure writer therefore atomically
records the failed root and reconciles still-running child headers whose exact
native invocation is already cancelled. It appends one cancellation event per
settled header, retaining the observed native identity. Foreground descendants
of that cancelled invocation are included through their bound native ancestry.
A descendant with its own non-cancelled native task is excluded; ancestry alone
does not override that task, including when it is parked for approval.

This is a projection of settled native cancellation, never a native state override
or permission to accept rejected usage. The ownership graph, original root turn,
native task owner/run/tool-call tuple and child event identity must agree.
Suspended or running native siblings, other turns/roots, changed owners and
already-terminal headers remain unchanged. Repeating root failure does not append
another child terminal. A terminal-event write failure rolls back the root and
child status transition together. No rejected usage refresh or replacement row
is emitted; the original persistence error remains visible.

Paired checks: `delegated-usage-failure.integration.test.ts` exercises two real
native children and the production persistence pipeline; `delegated-stream-failure.integration.test.ts`
pins scope isolation, descendants, idempotency and atomic rollback. The injected
wrong-resource rejection proves failure containment, not the missing original
usage tuple's cause.

### Selected child cancellation (BST-1723)

The child projection captures the invocation's existing abort signal at native
admission (BST-1770). Selected Stop therefore classifies that child's subsequent
unwind as cancellation, even when native execution reports an admission error
while unwinding. Retain the controller for the runtime-owned binding lifetime, beyond native
tool-hook completion; queued stream parts still belong to that invocation. Native approval resume may re-enter preparation after the prior hook completes;
reuse that invocation's non-aborted controller while rejecting concurrent preparation
and attempts to restart a stopped invocation. Never infer
sibling cancellation from the root's state or suppress a persistence rejection.
The real desktop runtime regression asserts Alpha native/durable cancellation,
exactly one cancellation event, Beta still running, and Beta's later completion.

`POST /assistant/cancel-child` resolves an owned child and explicitly selects either
that child or its subtree. It first revokes admission on the existing invocation
rows, then joins registered native execution owners and stored background cleanup.
Only after those joins does it settle still-running ordinary child run projections
and append their `run.cancelled` event. Earlier completed legs and siblings retain
their status. A failed join returns an explicit incomplete cancellation response;
revoked admission remains durable and does not imply successful teardown.
Stop selects a conversation, including its admitted invocation legs across turns;
it does not select just the currently displayed message. Child host-run IDs include
the host leg and complete native invocation identity, so distinct invocations never
share a terminal projection. Native task selection includes terminal tasks: completed
status can precede workflow deletion, which Stop must still join. Stored cleanup
preserves completed/failed outcomes while removing their workflow snapshots.
Controls register before the runtime can be returned for streaming and remain
registered through shutdown. The host snapshots those live capabilities, checks their
root ownership in one bounded query, and joins them after durable admission revocation.
A subsequently constructed runtime cannot admit a revoked invocation.

The same barrier rejects subsequent child steps, repeated invocation admission,
and pending decision claims after host reconstruction. Closing a tab never invokes
it. Shared conversation controls expose Stop for live execution and reloaded pending
decisions, await the host acknowledgement, and reload actual child history.

The shared workspace navigation provider resolves native invocation addresses for
both root and child cards. Background acknowledgements do not contain a child
address, so persisted event identity remains necessary after reload. Resolution
checks owner, root and the selected parent; it never scans other turns by call ID.
Production proof: `delegated-worker-write.desktop.test.ts` stops a reloaded pending
child, preserves the absent write, sends another parent message, reloads, reopens
the original child, and checks cancelled persistence without another model call.

Construction must unwind cancellation registration and all runtime cleanup owners
when a later Apps admission registration throws; preserve both construction and
cleanup errors. Shared Stop eligibility reuses the approval/suspend notice's exact
identity and resume outcome: separate successful decision messages retire historical
pause controls, failed decisions remain actionable, and sibling decisions do not
retire the selected child's pause.

Active human follow-ups use the observed child identity and its existing persona
agent signal owner. The shared child composer sends through the authenticated
host, which rechecks owner, root, active host and cancellation admission. Native
user signals are durable chronological child turns; they do not become parent
input or launch a second runtime. See the active-input receipt and interruption
contract in assistant-persistence.md. Production coverage spans native foreground
and background delivery and the shared Electron child-composer path.
