# Child run controls, composer, usage and checkpoints — evidence

Supports `docs/agents/assistant-subagents.md` § "Settings inventory and reset release proof".
Supports `docs/agents/assistant-subagents.md` § "Selected child scope and captured usage".
Supports `docs/agents/assistant-subagents.md` § "Next idle child run controls".
Supports `docs/agents/assistant-subagents.md` § "Structured child composer input".
Supports `docs/agents/assistant-subagents.md` § "Native child workspace reads and checkpoint undo".

The factory-reset inventory proof, the child details surface, next-run configuration (including the deny-only permission ceiling), structured composer input and checkpoint undo.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 2896–3079 at commit 7c3eb8f38.

---

`delegated-factory-reset.desktop.test.ts` toggles Settings' master delegation
switch and observes the next real native Mastra request at the external model
provider boundary. Enabled requests advertise `agent-worker`; disabled requests
advertise no `agent-*` tools while retaining ordinary tool discovery. After
Settings factory reset and process restart, the default switch and an actual
subsequent worker-capable inventory return. The existing provider shim supplies
model text only; the app's assistant endpoint, request preference propagation,
persona resolution and tool catalog construction run unmodified. This case does
not execute a delegated workspace effect; the worker fixtures own that proof.

### Selected child scope and captured usage

The selected child's details surface reads its authorized durable configuration,
actual child run model/provider and tree depth. It uses the same admitted-profile
parser as native resume; an invalid legacy profile remains an explicit error,
never a different persona. The displayed tool list is the admitted maximum, still
subject to current host permissions. A missing captured effort value is displayed
as not recorded; it is not inferred from the parent's current selector. Continuation
receipts with an execution snapshot display their actual model, generation effort,
output limit, plan state and permission policy. The latest authorized receipt is
read separately from the original admitted maximum.

Direct captured usage and inclusive child-plus-descendant usage reuse the main
conversation's cumulative usage component and pricing resolver. Inclusive totals
already include the selected child and must not be added to direct totals. A
missing usage record is not zero spend; unknown model pricing remains unavailable.
The reader follows exact invocation and continuation attribution because ordinary
child usage rows are stored under the root thread. The assembled desktop
acceptance uses that same root/resource/parent-run/tool-call attribution when
checking each survivor's usage, and opens the child conversation to verify its
answer when the root activity is collapsed. It does not sum the root's
entire bill into each child. Only retained conversation attribution is shown;
ordinary root totals still retain numeric history after child deletion. Current
work may not yet have reported its final usage.

### Next idle child run controls (BST-1727)

The child reuses the main composer's model picker, generation/effort controls,
plan control and tool menu. Its draft is local to the exact child panel. Before
an explicit override, the selected model comes from the admitted persona pin or
its owning root's live per-thread selector; provider settings and plan mode come
from that same root store, not another thread or global settings alone. Desktop
children use the same shared provider-discovery resource as the parent even when
the parent panel is not mounted.

Historical Retry/Edit reads admission ancestry and restart capture in bounded
80-message pages. An empty branch prefix reads no message page. Its baseline
excludes events whose canonical native-message owner (or, when absent, turn
owner) is outside the branch. Retry also excludes turn-owned events for the
replaced answer, even though its user prompt remains in the prefix. Legacy
ownerless events retain chronological
assignment; an empty prefix has no events to project. The native branch
history verifier observes transaction-handle queries as well as outer capture
queries, and exercises missing targets and cycles directly.

Idle input and historical branch actions wait for a valid admitted persona.
A malformed latest execution receipt displays a concise, explicit error while
retaining the original admitted persona and tool/step limits; raw schema issue
JSON is not user-facing copy, and unreadable execution settings are not inferred.

Changes apply only to a new idle-child input. Active input carries no next-run
configuration. The shared composer captures the complete next-run request once;
an unconfirmed retry keeps that exact receipt and settings despite later control
changes. Changing text/images still requires explicit discard. Browser receipts
exclude credentials and local endpoint configuration. The host resolves credentials
through the existing admitted-persona provider path.

Every new native child also records the actual generation options installed on
its Agent through the existing trusted admission binding before native input is
persisted. No new context registry or renderer-provided authority is introduced.
Original decision resume restores execution snapshots alongside admitted persona
profiles at each exact ancestry depth. A different pinned descendant model uses
its own defaults instead of inheriting options intended for another model. The
current root's permissions apply to that child's tool construction through
`intersectChildPermissionCeilings` (`packages/assistant-contract/src/child-permission-ceiling.ts`):
the admitted snapshot contributes ONLY its denies, so a root grant made after
admission (a session grant, a per-tool "Always allow", yolo) lifts an admitted
`ask` on the very next resume leg, while a later root reduction still applies and
the admitted tool catalog stays frozen. SETTLED 2026-09-12 (do not relitigate):
the earlier symmetric "stricter wins" rule froze every admitted `ask`, so the
grant buttons on a child's approval notice could never end the prompting — one
Explorer tree paused 87 times on `readWorkspaceDirectory` and exhausted its
step budget without reading a file. Paired spec:
`child-run-configuration.spec.ts` ("child permission ceiling honors root grants
made after admission"). Because that grant removes the approved tool's `ask`
flag before the child resumes, the approval-resume leg builds children with
sequential tool calls (`approvalResumeLeg` → `resolveChildToolCallConcurrency`,
see `assistant-runtime.md` "Parallel tool calls"); otherwise Mastra's parallel
foreach resume re-raises approval for the allowed siblings of the approved call
(2026-09-13 `globWorkspace` pause + "multiple pending calls" 502).
Older rows without an execution snapshot remain explicitly unrecorded.

Migration 137 persists an execution configuration on each continuation receipt.
Admission validates the current host model and image capability, combines root
permissions under the deny-only ceiling above, prevents disabling root plan mode,
and permits only reductions of the original admitted tool catalog. Resume reads
the receipt's exact profile and generation settings and applies the current root
permissions (grants and reductions) under that same ceiling. A pending
decision is not affected by future draft edits, reload or different parent effort.
Child settings never replace the parent outcome leg's settings. Null legacy
execution configurations retain the explicit original-profile compatibility path;
migration rollback refuses to discard non-null execution snapshots.

Verification: real PGlite upgrade/replay/reconstruction and receipt identity tests;
actual first-delegation and continuation admission/decision resume with child high/777 while
the parent uses low/42; public composer retry retains the original configuration;
shared Electron child image/idle/reload/approval path observes selected xhigh on
the real provider wire before and after pending-decision reload.

### Structured child composer input

The shared composer uses the same image adapter, file mentions and workspace slash
commands as the root. Image-only drafts are valid in both active and idle children;
Send and Enter share the same content-presence and delivery gates. The selected
child's captured running model determines active vision availability. An idle child
uses its admitted persona model pin, or its owning root's current per-thread model
selection when unpinned. A previous run's model never overrides the next selection.
Known unsupported models reject images visibly; unknown provider capabilities use
the canonical root policy and surface actual provider errors.

Only the authenticated host resolves file/skill references. Caller-supplied system
context is rejected. Native message signals retain structured file parts and bounded
host context; live frames and reloaded messages use the ordinary shared renderer.
The latest native user signal replaces only its input-context tag; absent or empty
context clears the older tag without altering admitted persona or workspace authority.
A stable receipt binds the entire normalized payload, including image bytes, through
acknowledgement loss and restart. Migration136 stores that payload on the existing
reset-owned continuation receipt; legacy text-only receipts remain readable. Downgrade
permits only payloads losslessly represented by the retained input text; image or
conflicting-content payloads refuse downgrade.
Acknowledgement clears only the sent attachment cohort and unchanged text, preserving
newly staged input. An unconfirmed changed payload requires explicit discard rather
than silently reusing its receipt or replaying the input.

The shared effort control offers an OpenRouter ladder only from the selected
model's declared or matching live metadata; it never borrows direct OpenAI
defaults while routed-model metadata is pending. This keeps first-child admission
and the visible root controls on the same capability contract.

Continuation token accounting uses Mastra's public `processOutputStep`, which
reports the completed model response before tool execution can pause. A paused
native stream has no `step-finish` and its terminal usage is zero; a resumed
terminal includes earlier paused model responses. Neither is a per-host-leg
charge. The admitted child's processor persists cumulative provider-reported
counts within the current managed host leg, and the continuation projection emits
those same counts. A fresh decision leg starts a fresh meter; native cumulative
finish values cannot duplicate earlier spend. Stopping an already paused child
therefore retains its reported model usage. Missing provider counts do not create
a fabricated usage row. The three-process sibling fixture checks 1/1 on each
paused child and 1/1 on the surviving child's resumed leg, both live and durable.

### Settings inventory and reset release proof (BST-1727/BST-1728)

`delegated-factory-reset.desktop.test.ts` toggles Settings' master delegation
switch and observes the next real native Mastra request at the external model
provider boundary. Enabled requests advertise `agent-worker`; disabled requests
advertise no `agent-*` tools while retaining ordinary tool discovery. After
Settings factory reset and process restart, the default switch and an actual
subsequent worker-capable inventory return. The existing provider shim supplies
model text only; the app's assistant endpoint, request preference propagation,
persona resolution and tool catalog construction run unmodified. This case does
not execute a delegated workspace effect; the worker fixtures own that proof.

### Native child workspace reads and checkpoint undo (BST-1726)

The native tool execution thread, not the parent tool-factory closure, owns
read-before-write timestamps and paged-read cursors. Per-file locks remain the
existing serialization boundary. The authorized delegated invocation resolves
the checkpoint's resource and host-leg run with the same `delegatedHostRunId`
function used by event persistence.

Desktop memory wiring supplies pre-execution snapshot capture to host admission.
The shared child view reuses `EditCheckpointProvider`/`useEditCheckpoints` with
the child's thread ID; terminal store events refresh the ledger. Browser views
without the checkpoint bridge do not query or expose native checkpoint controls.
The Electron worker test proves child restore after reopen, durable reverted
state after reload, preservation of an independent user file, and no new model
request. This does not complete all workspace coordination acceptance.

Delegated native file mutations carry the selected execution's abort signal to
the per-path mutation boundary. A child stopped while waiting for a shared file
lock cannot mutate after the lock becomes available; completed child edits stay
inspectable and a sibling retains its own execution signal. The four real queued
write/replace/delete/rename cases live in the workspace staleness integration suite.
