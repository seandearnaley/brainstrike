# Settings preflight, idle-child input and admitted configuration — evidence

Supports `docs/agents/assistant-subagents.md` § "Persona Settings host checks (BST-1727)".
Supports `docs/agents/assistant-subagents.md` § "Managed idle-child input".
Supports `docs/agents/assistant-subagents.md` § "Admitted persona configuration on decision resume".

The Subagents preflight facts, the managed continuation receipt, and the immutable admitted persona configuration restored on resume.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 2721–2892 at commit 7c3eb8f38.

---

Settings → Subagents refreshes the ordinary validated workspace/global persona
scan and shows host preflight facts from the existing model catalog, typed
credential reader and MCP tool registry. Missing/unreadable required credentials,
catalogued non-language models, providers without LLM capability, and the built-in
local model's unsupported Worker discovery are blockers. The local-worker rule
is shared with actual agent admission. An unlisted model pin
or missing/disabled MCP tool is actionable attention, not a claim that a custom
model is invalid or that the entire persona is unavailable. Native capabilities,
selected parent model, durable child controls and permission policy remain
per-request checks; a passing preflight never promises effective access.

Declared scope remains visible beside these facts. Refresh rereads profile edits
and host facts with one scan in flight, without executing a model or changing
running children. A failed scan/check shows a visible error and Retry, retaining
any previous list as such;
it does not silently substitute built-ins for a successful user-profile scan.
No credentials enter the IPC response and no new state is persisted. Existing
subagent-personas factory-reset registration remains authoritative.

### Managed idle-child input (BST-1723)

A user follow-up to an idle child starts a fresh managed root host leg and wakes
that exact stored child with Mastra's public `createMessageSignal` / `sendSignal`
API. The renderer supplies only the selected child, stable input ID and structured
text/image payload;
the host authorizes the actual resource/root/ancestry and claims a separate
continuation receipt. It never changes the original invocation or manufactures
parent tool-call coordinates. The receipt is claimed before native wake and binds
the accepted native run before the first continuation envelope acknowledges input.
A repeated admitted input ID never starts work again, including after an uncertain
acknowledgement or restart. Different text or image content under that ID is a conflict.

A pending decision owns its selected child, not the root's execution slot. Multiple
idle children can therefore retain independent approvals/questions, including
same-persona siblings with identical leaf tool-call IDs. Only one receipt may be
claimed/running under a root, and only one active receipt may own each child.
Both fresh input and decision consumption also reject another running/cancelling
managed root leg, including ordinary parent input. Stopping one paused child
preserves its sibling's exact pending receipt across host restart; neither restart
nor a repeated input/decision may execute an effect again.
`idle-grandchild-restart.integration.test.ts` proves depth-two continuation and
sibling Stop isolation through three distinct processes, real native storage,
parent outcome delivery, and unchanged original invocation identities.

The selected child retains its admitted persona and step cap. Direct child legs
must preserve the child's default budget and worker processors: root per-call
`inputProcessors` replace those defaults in Mastra. The existing-child scope
processor checks the exact authorized native memory identity; original delegation
birth and aborted-delegation processors apply only to new descendants. The shared
direct-turn runner owns the existing child's cancellation and aborted persistence.
Actual depth is added to recursive availability checks, so waking a grandchild
cannot reset its depth allowance. Every model step still charges the real child
identity against the managed turn's durable budget.
Fresh child input runs the ordinary workspace/reference/skill context injectors
against that input, without copying client-supplied system-role request messages.
Only host-injected system context crosses to the child, exactly once in the native
model prompt. The selected
child's default context processor also retains that context in native RequestContext,
so a descendant first created after a resumed decision receives the same authority.

Live frames use the shared conversation mapper with `brainstrike.child-continuation`
metadata, not fake parent invocation keys. The host assigns the new child assistant
message ID before native execution and supplies it to Mastra's public ID generator;
live projection and reloaded native messages therefore share identity. Parent and
child assistant IDs remain distinct. Exact approval/question decisions carry the
continuation ID; descendants additionally retain their observed delegation path.
A child pause keeps the managed turn open, and each resumed host leg reuses the
receipt's original turn anchor rather than allocating another budget.
The first direct envelope in each host leg carries its history baseline exactly
once. Reload discovers pending decisions with an inert native agent at the admitted
persona and exact stored child thread/run, then authorizes any descendant path;
it does not require the current persona registry or execute a model to inspect it.

Suspended-run discovery validates every root and child timestamp before
staleness and capping, even when no continuation receipt exists. Invalid values
fail the complete response visibly. Merged pauses remain oldest-first and keep
the newest ten.

Multiple approval or question calls emitted in one model step remain individually
addressable. The installed Mastra scheduler forces concurrency one when a called
tool requires approval or has a suspend schema; child agents use the native
`strategy: 'called'` option. Reload therefore discovers one pending call, then
the next after the exact first decision resumes. The native continuation test
covers two approvals (each effect once) and two questions from the same model
step. A multi-call suspended snapshot remains an explicit unsupported/ambiguous
shape; do not remove its guard based only on parallel model emission.

Completed child output reaches the managed root model through a public native
notification signal and the normal root stream/persistence path. The notification
contains the final completed leg's text; earlier paused-leg text remains in the
child's durable transcript and is not concatenated into that result. This is an
actual model response, not a synthetic assistant message or another transcript
writer. Approval/question pauses and cancellation do not wake that root model.
Binding failure aborts and joins native stream consumption before runtime disposal;
all terminal paths settle the receipt and preserve cleanup failures. If initial
history capture fails after admission commits, the host settles that receipt as
failed before returning the error; the same input id cannot replay, while a new
explicit input can be admitted. A settlement failure preserves both causes in an
AggregateError. Decision disposal consumes only claims still owned by that host;
validation before claim or an explicitly released unexecuted claim cannot replace
the original error with a spurious lost-claim failure. Failed receipts
retain the visible provider or thrown stream error. Completed model responses
persist provider usage before a tool can suspend, as described below; terminal
chunks project that same current-leg usage.
Recognized human continuation signals use one decoder in both projection paths;
malformed signals fail visibly instead of disappearing from child history. Restart does
not automatically replay either the child input or the parent notification.

`child-continuation.integration.spec.ts` exercises real Mastra/PGlite wake, saved
child history, exact approve/decline/question/plan controls, cancellation, failed
binding settlement, durable child step charging, depth limits and root notification
consumption. Host/repository tests cover the separate authorization, duplicate,
turn-link, replay/reset and atomic claim boundaries; UI production-path evidence
is required alongside these native tests before delivery is complete.

### Admitted persona configuration on decision resume (BST-1727)

An admitted child's stored `configuration` contains its persona instructions,
model pin, mode, effective tool IDs and the invocation's clamped step budget.
The host returns this immutable configuration only after authorizing the entire
decision ancestry. Both public approval and question/plan resume entry points
restore those profiles before constructing discovery or execution Agents.
Restoration is indexed by depth, so two admitted generations of the same persona
ID cannot overwrite one another. Registry edits, disable preferences and removal
apply to fresh root turns; a resumed native leg retains its admitted target
profile through completion and does not rewrite an already-admitted decision.
The resumed root leg may invoke that restored profile again; a new root turn
uses current registry availability.
Current host tool availability, permission rules and model credentials still gate
execution. Missing/invalid snapshots or an unavailable admitted profile fail
visibly before native resume; another persona or model is never substituted.
The browser-safe `AdmittedChildConfigurationError` carries only a fixed reason and
safe remediation. The shared HTTP initializer returns status 409 with that message;
profile text and underlying errors stay private. Missing/legacy shapes request a
fresh delegation, while a persona/path identity mismatch is a distinct integrity
failure. Unknown fields, invalid model providers and empty tool catalogs reject.
The schema exhaustively includes the persona contract's keys, modes and sources.

Wildcard worker profiles are expanded to their effective admitted tool IDs when
building the admission map. A later catalog addition cannot broaden that child's
resume. This captures the full eligible catalog before discovery hides unloaded tools;
`load_tool` can restore an admitted tool from child history after resume.
Older records retaining an unexpanded `*` fail with an explicit request
to start a new delegation; their original catalog cannot be inferred from today's
registry. Cross-provider pins reacquire credentials through the trusted host reader,
including when the live persona file has been deleted; credentials are not stored
in child configuration. `assistant-service/stream-init.ts` is the sole production
caller of the two public resume functions and injects that reader for both.
Restoration without an authenticated root runtime rejects before reading
secrets. Native Mastra snapshots retain the original delegated
task and workspace/system context. This boundary does not change native workflow
snapshot formats or create another execution owner.

Production tests: `delegated-persona-snapshot.integration.spec.ts` disposes the
original owner, discovers the stored approval/question after registry edits or
removal, resumes through the public entry point, and checks one effect plus child
and parent output. It also rejects when the admitted tools are no longer available at all.
`recursive-worker.integration.spec.ts` removes the live Worker before depth-2/3
resume and asserts that real admission receives expanded tool IDs, with no `*`.
`agent-stream-init-and-memory.integration.test.ts` proves fixed remediation reaches
the real HTTP response while unrelated initializer failures remain redacted.
`delegated-conversation-host.integration.test.ts` verifies stored configuration is
read only through the authorized root/turn path. Idle-child wake uses the managed
continuation boundary above.

The stored step budget must be a valid admitted value under this build's host
ceiling. Current admission cannot write a value above that ceiling. A future host
limit reduction must coordinate native snapshots and durable root/child counters;
clamping only this parser would not prove the running workflow uses the new limit.
Read-only `resolveToolAction` runs before profile reconstruction and again before
native decision admission. The second authorization intentionally rechecks current
ownership rather than caching authority across model/tool construction.
