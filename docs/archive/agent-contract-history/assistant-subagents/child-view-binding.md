# History baseline, host-owned child view and cancellation — evidence

Supports `docs/agents/assistant-subagents.md` § "Child history boundary for a live stream leg".
Supports `docs/agents/assistant-subagents.md` § "Host-owned child view binding".
Supports `docs/agents/assistant-subagents.md` § "Waiting-turn cancellation and native child control".
Supports `docs/agents/assistant-subagents.md` § "Child interactive production entry".

The immutable pre-leg baseline, the workspace root registry and child tabs, waiting-turn cancellation, and interactive tools in custom personas.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 1460–1712 at commit 7c3eb8f38.

---

A child decoder contains one host stream leg, not a complete conversation.
Native resume can update a previous row's tool result and append continuation
text in another row. Its latest observed message id therefore cannot be used
to remove or replace a single history row. Identical text before and after a
pause is legitimate content, not evidence of a duplicate.

The desktop binding captures an immutable history baseline after the exact
leaf decision is claimed and its native snapshot validated, before invoking
native resume. Every ancestor on that admitted path uses the ordinary history
readers in `@brainstrike/db`, including rewind tombstones, message parent topology and the existing
80-message/run hydration window. All reads must succeed before any baseline
is published. A different leaf cannot borrow the claim; releasing an
unexecuted claim clears its snapshots so a later admission reads fresh state.
For a newly created invocation, only already persisted input rows belong to
the baseline; the current assistant output belongs to the decoder.

The first delegated envelope carries this baseline with authoritative child
thread and host-leg ids. Abnormal termination also carries it if no earlier
renderable chunk did. Subsequent envelopes cannot introduce or replace the
boundary. Replay recreates the decoder and replays the same boundary. These
snapshots are ephemeral stream data; native Mastra memory remains the writer.

`delegated-resume-parity.integration.test.ts` proves real approve/decline and
identical-text native continuations deliver pre-effect history through the
production decoder. The host integration test proves exact admission and
release/recapture, and projection/receiver tests pin termination and ordering.
The baseline is the transport prerequisite for BST-1724's shared live view;
it does not by itself enable child controls or remove persona capability gates.

The readers and native row conversion live in the Node-compatible DB package,
not the renderer-facing `assistant-data` entry. Electron main externalizes
workspace imports as CJS requires; a browser-only export can type-check and
still prevent application launch. The main-process external-require verifier
and real Electron launch smoke are part of this boundary's validation.
Both renderer and desktop consume the same readers. The desktop database handle
is released only after migration; the renderer repository's initialize step is
an assertion, not lazy DDL. Run-event timestamps and metadata are normalized by
the common row mapper before serialization.

Concurrent binds share a single in-flight initial history read. Mastra 1.64
creates a new child thread per delegation (even an input thread id gets a UUID
suffix); the initial baseline therefore contains input, not an earlier child
turn. The native test asserts this input and non-empty normalized run events
on resume. A consumed decision retains its baseline until that host leg ends;
finish runs at runtime disposal, so later continuation uses a new binding.
Capture or validation failure stops admission and releases the unexecuted claim;
it must never omit history and proceed as if the child view were complete.

The DB unit and browser test projects must resolve the history reader's
`assistant-contract/run-events` subpath before their root package alias. A
root alias targeting `src/index.ts` cannot also resolve a subpath; the static
workspace-source verifier and the DB entrypoint/worker tests guard this edge.
The native parity assertion pairs the pre-effect marker exclusion with the
approved leaf result, so the exclusion cannot pass after the fixture marker
disappears. Terminal projection tests use a nonempty second producer to prove
that abnormal termination is published only once.

### Host-owned child view binding

The shared child view combines the baseline with its live leg through the
public assistant-ui external-store runtime and converter. The vendor content
concatenator updates a repeated tool-call id in place and preserves identical
text on either side of a resume. It replaces only the active history head;
saved branch nodes retain their parent edges. Native row ids do not determine
the lifetime of this live leg.

The app-shell child store publishes complete snapshots, scoped to an exact
native invocation and authoritative child thread. Current-leg replay replaces
the prior snapshot; callbacks from a superseded leg cannot overwrite an admitted
continuation. View unsubscription does not clear the host's output. The shared
panel subscribes to that store, so closing/reopening a view neither invokes a
model nor loses output produced while the view was closed.

A child decision is accepted only if its validated native ancestry includes
that view's invocation. A current host snapshot supplies its validated live identity;
a restored view resolves identity against the durable invocation graph. Both
paths still require native host authorization. Its action metadata and run configuration go through
the owning root runtime, without the child's message parent/source ids. The
root owns its own append topology and the native host still authenticates the
full decision path. Ordinary follow-up prompts are not decision messages;
steering and cancellation remain explicit coordination capabilities.
`AssistantUiPanel.onRuntimeReady` registers the actual owning runtime and its
returned cleanup runs when that runtime is disposed. Opening a child view must
never construct another inference runtime.

The workspace owns the ephemeral root registry, keyed by owner resource and
root thread together. Snapshot reads are pure: committed external-store
subscriptions acquire a lease for each mounted owner or child view. Releasing
the final lease evicts the root and clears its converted transcripts; saved,
unvisited tabs recover through native history when mounted. A stale cleanup
cannot evict a replacement. Registration captures the actual thread handle and
its runtime identity, and decision append rejects a handle that has retargeted.
 The actual panel wrapper publishes delegated snapshots
and registers its actual runtime into that root; standalone panels without a
workspace do not advertise child navigation. Runtime cleanup is identity-aware:
disposing an old runtime cannot unregister a replacement. An unavailable owner
rejects a decision before append, while previously captured child output stays
available for inspection. Removing the production stream callback in the manual negative-control run
makes the wrapper behavioral test lose its observed child output. The committed
test exercises the restored production callback.

Child workspace tab addresses encode owner, root and child identifiers and use
the existing workspace selection store's singleton/open/close/hydrate behavior.
An address is not authority: the durable graph still authorizes history reads.
Ordinary app ids remain untouched; malformed reserved child addresses must
surface as errors rather than silently disappear during restoration.

The shared child panel accepts ordinary persisted history for a view reopened
without a live host envelope. Its caller must authorize the child against the
durable graph before supplying that history. A live host snapshot replaces the
saved projection with its own baseline and continuation; opening either view
never invokes `onNew`. The panel's regression test uses the real ordinary-history
converter and proves both no execution on opening and the saved-to-live handoff.
An explicit search hit can extend a child baseline backwards through bounded native history pages. The shared view merges older durable context while retaining the host's current head and live controls; it never imports another inference runtime or writes transcript rows. The saved-workspace coordinator opens the owning root before the singleton child tab, and the shared transcript resolves native snapshot IDs to their rendered assistant group. `delegated-child-reload.integration.test.tsx` exercises a grandchild hit older than the initial 80 rows, close/reopen, ancestry, unchanged parent draft, and no execution.
The subagent card's optional Open conversation action is separate from its
collapse toggle. Navigation binds the exact parent tool-call id to its host
baseline thread id; contradictory addresses surface as card-local alerts, with
no navigation action, rather than throwing from the streaming selector. The action is absent
until the workspace supplies a navigation capability.
Pending invocation lookup failures stay visible beside the Open conversation
action. The action clears that error and performs one fresh lookup when the user
explicitly retries; the shared UI never polls or silently retries a host binding.

`DelegatedWorkspaceTabsProvider` registers saved child tab addresses before the
ordinary workspace provider reconciles selection. It resolves native graph
ownership and persisted callsign/color before mounting a transcript. Unselected
restored tabs load metadata only; the existing WorkspaceBody controls transcript
mounting and closing. Invalid reserved addresses remain visible error tabs.
Both the main wrapper and child panel provide the same navigation action. The
workspace integration test opens the real shared child panel, closes it, and
reopens output published by the owning host while it was closed; removing the
navigation context is its negative control. Restored decision routing and
sidebar ancestry are not implemented by this registry boundary.

The shared transcript data-renderer registrations live together in
`assistant-data-renderer-registration.tsx`; the panel still mounts that component
for both root and child views. This keeps the panel within its existing source
budget without weakening the guard or changing approval, suspension, timeline,
or hidden metadata rendering. Workspace metadata is retained only for open tabs:
closing and reopening forces graph authorization before prior metadata/history
can be exposed. Child loading views subscribe to their owning host so a live
snapshot can become visible while an ordinary history read is still pending.
Metadata reads skip already authorized entries for the current database; app
arrays retain their identity until their inputs change. A malformed invocation
binding takes precedence over a simultaneous discovery request failure.
The root-layout test pins the owning provider around the actual assistant slot.
The reload integration test uses the native history reader and its ordinary
hydration window as the arriving live baseline and retains earlier transcript
text after the handoff. The Electron smoke test also asserts root edit/reload
controls are present before checking their absence from the read-only child.

Panel runtime composition keeps endpoint resolution/cancellation in
`use-assistant-endpoint-api.ts` and stable attachment/history adapter construction
in `use-assistant-thread-runtime-adapters.ts`. Attachment identity is keyed on
capability presence, so disabling a model's vision support does not discard
already staged attachments. Optional callback props that explicitly accept
undefined pass directly; plan-mode configuration is assembled before transport
selection. These boundaries preserve the existing runtime/transport tests and
remove the reviewed panel/runtime complexity findings without rule suppression.

A child reopened after renderer restart has no live snapshot identity. Its
explicit persisted-decision resolver binds the selected child's thread id to a
native invocation in the decision path and validates owner, root, parent run,
parent call, child run and persona. Same-persona siblings are never interchangeable.
The owning runtime must exist before lookup and remain the same after it; a
runtime disposed during lookup cannot receive the decision. The final native
host admission remains authoritative.

Child pause rediscovery queries the owning root's thread/resource, then projects
only paths whose durable invocation belongs to the selected child. Root-only
and sibling pauses are omitted from that child's view. Missing/conflicting path
bindings surface an explicit discovery error; known transcript content and valid
recovered decisions remain visible. Capability gating reuses the same durable
assistant backend capability as root history. Native restart and full rendered
control parity still require the end-to-end delivery checks.

The workspace's component exports and hooks are separate modules so Fast Refresh
preserves component state: root registry access is in
`use-delegated-conversation-root.ts`; its `useDelegatedPanelBinding` hook supplies
stable capability-shaped callbacks without conditional registration logic in the
main wrapper. Metadata loading is in
`use-delegated-workspace-apps.tsx`; child view and navigation components have their
own files. Metadata cache removal responds directly to the existing selection
store's close/hydrate notification, not a synchronous setState during an effect.
The ordinary root history adapter has its own hook, and the actual wrapper
stream-binding regression has its own discovered test file. Shrink-only wrapper
budgets must ratchet downward after extraction; ESLint warning baselines must
not increase to accommodate these boundaries.

`delegated-child-reload.integration.test.tsx` exercises the actual ChildView and
shared controls against a migrated PGlite database with native-format history,
a persisted graph/invocation, and a registered owning-root append boundary. It
verifies root-scoped discovery, actual approval/question clicks, native target
preservation, and omission of child topology. It also proves live output can
arrive during recovery and that recovery failure leaves saved history visible.
The discovery HTTP response and final root append are test boundaries; native
Mastra execution/restart remains covered separately by the desktop fresh-process
harness. Do not describe these as one full browser-to-native end-to-end test.
Approval and suspension binding lookups run concurrently as independent reads.

The shared assistant action bar reads the public runtime `capabilities.reload`
before rendering regeneration. A child without an `onReload` adapter must not
advertise this action; enabling the composer or a generic `onNew` decision
dispatcher does not authorize regeneration. Copy remains available. The shared
panel tests exercise both supported and unsupported runtimes, and the Electron
workspace restoration verifier checks the actual child control surface.

### Waiting-turn cancellation and native child control (BST-1720)

`POST /assistant/cancel` records cancellation against the owning resource/root/turn
before aborting registered legs. A completed host leg is eligible only while
public native suspended-run discovery still finds one of that turn's root
invocations. Native snapshots remain Mastra-owned; no opaque snapshot is edited
or used as application state. A cancelled original turn rejects a newly created
resume leg in the atomic durable admission statement. Both native attempt legs
check the owner signal again after awaited admission, before invoking resume.
Both server and renderer terminal writers preserve an existing cancelled status.
Repeated cancellation still aborts registered same-turn legs. Acknowledgement
waits for their teardown, then finalizes cancellation even when the normal
terminal write preceded unregister. Completed earlier legs retain their status
unless they are the specifically requested waiting leg.

Discovery preserves real admission states first. A native pending decision with
no admission record in a cancelled turn receives the explicit non-actionable
`cancelled` display state; it does not create a fabricated admission. Shared
cards explain that the turn was cancelled and lock the original decision.
Cancellation is cooperative for work already executing, never rollback.

Proof: native sibling decisions, real HTTP waiting cancellation/reconstructed
host rejection, and admission-cancellation attempt regressions. The provider-shim
Electron scenario uses the actual host, permission engine, workspace and shared
child panel; it does not replace the assistant endpoint. Full question/plan,
process restart and worker acceptance remain distinct gates.

### Child interactive production entry

Custom personas can explicitly declare askUser and submitPlan. Their maps reuse
the parent runtime's canonical resolveSuspendToolsForRun gate, with the complete
durable child-decision capability as the availability condition. This gate is
independent of permission-ask flags: a read-allow self-suspending tool still
requires storage, exact routing, admission and settlement. Default built-in
toolsets, read-only enforcement and parent-owned task lists remain unchanged.

The real Electron interactive verifier uses an isolated workspace persona and
scripted external model transport; questions and plan approve/reject actions
flow through the actual child workspace, reload, native tool resume, child
model result and parent continuation. Existing native grandchild/process-restart
proofs remain separate and are not repeated to prove renderer interaction.

A child plan approval never exits the root's plan mode, including when its
forwarded notice is acted on in the parent panel. The delegated decision keeps
its exact leaf envelope; only a root plan may invoke the root plan-mode exit
callback. Child inspection already shadows that callback with its own context.
