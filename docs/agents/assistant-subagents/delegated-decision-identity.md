# Exact delegated decision identity and recovery display — evidence

Supports `docs/agents/assistant-subagents.md` § "Exact delegated decision identity".
Supports `docs/agents/assistant-subagents.md` § "Durable delegated decision recovery display".
Supports `docs/agents/assistant-subagents.md` § "Forwarded interactive pause presentation".

Leaf decision identity, the three-process restart verifier, interrupted-claim terminality, and the rediscovery annotation rules.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 1290–1456 at commit 7c3eb8f38.

---

A delegated pause carries its observed root-to-leaf native invocation path and
the leaf tool-call ID. The root run/call remains Mastra's transport target; it
is not the decision identity. Core 1.64 reuses that root alias when a child
pauses on another tool, so notices, notification dedupe and rediscovered
message identities key the leaf run/call. Parent and child views send the same
canonical root action plus the immutable leaf guard. The 32-edge wire ceiling
bounds parsing only; it does not enable recursion or define an execution budget.

The desktop host reauthorizes every edge against the owning root, original
turn, native child run, persona and parent thread. Native freshness uses public
`Agent.listAgents` and `Agent.listSuspendedRuns` under those observed scopes.
Never derive resource/thread IDs from native ID strings. A missing or ambiguous
pending leaf rejects before execution. Snapshot validation is repeated after
acquiring durable root admission, because another resume can finish between the
initial read and admission. Migration 131 retains a unique leaf decision record
and permits only one claimed decision per root. Runtime disposal settles only
its own claims; another recreated host cannot release them. Startup reaping
marks abandoned claims interrupted and retains their identity, without replay.
An interrupted leaf is TERMINAL and has NO recovery path, by design: only a
`claimed` row can be consumed or released, the card renders as settled
(`DECIDED_DECISION_STATES`, `undecided-pause-notices.ts`), and its background
task stays suspended because the reaper repairs `pending`/`running` tasks only
— nothing replays an effect that may already have happened. A session grant
therefore SKIPS such a sibling rather than failing the grant over it
(BST-1749 follow-up): the loud failure it used to raise recovered nothing and
refused the user's own card on every retry that still carried the grant.
The record describes admission, not whether a tool effect succeeded. If the
post-admission snapshot recheck fails before native resume is invoked, the host
rolls back only that binding's matching unexecuted claim and propagates the
failure; so does any later failure before the approval leg invokes native
resume — locating the parked task or answering the parked siblings its
grant covers (`beforeDelegatedToolActionResume` around
`claimGrantedBackgroundResumes`, which releases through the owner that took
the claim: the continuation host for a child continuation decision, the
delegated ledger otherwise). Left to disposal, `finishToolActions` consumed
the never-executed claim and refused the still-parked card for good
(BST-1749 review; desktop row "an approval leg whose granted sibling is
refused releases the user's claim", `delegated-tool-actions.spec.ts`).
Subsequent native failures or cancellation do not release the leaf:
the effect may already have occurred. Disposal attempts all cleanup owners in
order and preserves multiple failures in an `AggregateError`; it never logs
and swallows a failed decision settlement. Construction failures on every
initial/approve/decline/resume leg retain both the original failure and any
disposal aggregate as the typed error's cause, and explicitly report incomplete
cleanup to the caller while preserving an original typed error's code and
context. This is the runtime-wide construction error contract in
`assistant-runtime.md`, not a delegation-only exception.

The native process-restart verifier runs three separate Node processes against
one on-disk PGlite database, using the real Mastra parent/child/grandchild agents,
Brainstrike memory store, delegation binding, host admission and startup reaper.
Only the model transport is scripted. A suspended grandchild can be approved
once or declined without executing its effect after the originating process
has exited. A third process rejects the same durable decision even without
consulting an already-consumed native snapshot. If the second process exits
after admission without invoking or settling the tool, startup retains the
claim as interrupted and refuses replay. The fixture records distinct process
IDs and a durable effect count, not just reconstructed JavaScript objects.

This is native Node/Mastra restart proof, separate from Electron renderer reload
and packaged desktop UI coverage. It does not enable write-capable personas or
claim sibling, cancellation, or packaged interactive recovery UI parity.
The same fixture now runs the production askUser and submitPlan tools with
the production sanitizer. A fresh process answers a grandchild question or
approves/rejects its plan, verifies the exact result in the leaf model prompt
and the final parent answer, and rejects the consumed decision on another
restart. No second suspend is accepted as successful completion.
The paired `delegated-process-restart.integration.test.ts` is discovered by the
existing desktop integration lane; no bespoke CI lane or production test route.
Its separate Node processes resolve public package exports rather than Vitest
source aliases. Desktop `test:integration` and `test:coverage` therefore declare
exact `@brainstrike/agent#build` and `@brainstrike/assistant-data#build` dependencies
for the agent fixtures and startup reaper, including their DB/contract closure.
Direct Vitest invocation needs those builds first; the CI Turbo invocation
schedules them automatically from a clean checkout.

The native `beforeToolCall` hook captures the original parent model invocation
through Mastra's public `MessageList` adapter, before delegation starts. The
short-lived capture uses native execution thread/call identity, and the host
stores that input on the immutable invocation. The hook's `input` already has
Mastra-injected scope defaults, so it is not substituted for the model's input.
`onDelegationStart.messages` does not include the current call in core 1.64.
Approval resume displays the original parent call while preserving the leaf
tool as the approved operation. Missing original input refuses both approval
and decline visibly,
never a fabricated delegation call or leaf arguments under a parent ID.

Keyless rediscovery walks the same authorized graph and uses inert Agents with
the original persona IDs to list native child snapshots. It loads no tools or
provider credentials and does not resume workflows. The native reconstructed
parent/child/grandchild fixture checks identity, original parent input, leaf
arguments, approve-once/decline-never behavior and transcript parity. Host,
contract, projection, notice, notification and hydration tests cover their own
boundaries; negative controls remove root uniqueness and advance the native
leaf during admission. These proofs do not yet constitute packaged process
restart or complete child interaction UX.

Persona read-only, ask-tool and interactive-tool restrictions remain until the
remaining BST-1720 production entry, question/plan, interrupted-state UI and
end-to-end acceptance is green. This foundation does not enable mutation tools
or unrestricted recursive workers.

### Durable delegated decision recovery display (BST-1720)

The suspended-runs endpoint annotates each rediscovered native leaf with its
exact durable admission state, scoped by owner, root, root transport call and
leaf run/call. `claimed`, `consumed` and `interrupted` mean the same decision
cannot be resubmitted; none asserts that its tool effect succeeded. A later
leaf behind the same parent alias remains independently actionable. Discovery
only reads admission records and never creates a pause from them.

The existing approval, question and plan cards retain their original content
and show the admission status with controls locked. Unknown present states
fail wire validation and render an unavailable status if encountered directly
in a card. Only a pause without a durable decision is actionable; claimed,
consumed, interrupted and cancelled pauses never mark sidebar attention, and
staleness without admission state remains advisory. Status refresh
uses the existing thread reload; no polling or auto-resume is introduced.
The server's durable admission check remains authoritative if a claim races
this read. Missing/ambiguous native snapshots still use the visible discovery
error path; this slice does not reconstruct missing snapshots.

Paired proof: the delegated-decision-discovery endpoint tests, real PGlite
cases in delegated-conversation-host.integration.test.ts, shared notice and
contract tests, and assistant-approval-reload-linearity.desktop.test.ts.
The Electron test exercises renderer reload and real history hydration with a
scripted discovery response; the database test independently verifies admission
state and ownership. Neither claims packaged process-restart UI parity.

The decision-state SQL joins the complete deduplicated root-run/root-call/leaf-run/leaf-call
tuples, so retained historical decisions for the same child are not fetched or
validated. The lookup uses only returned pauses (including the existing
newest-ten suspend cap). Ordinary pauses require no extra decision-database
read. A failed query or invalid saved state remains a visible discovery error;
it must never become an empty annotation map that re-enables a consumed leaf.
Explicitly undefined/inherited decision-state fields are invalid, not absent.
Interrupted claims cannot safely offer retry: follow-up/cancellation controls
remain part of BST-1723, and never erase the original admission record.

### Forwarded interactive pause presentation

A native parent suspension names its delegation tool (`agent-child`), while
its decision belongs to the leaf. The authorized recursive stream projection
retains the observed leaf pause and restores its tool name, payload/arguments
and resume schema before the shared mapper classifies approval or typed resume
support. Root and intermediate transport run/call coordinates remain unchanged;
the exact leaf guard still owns decision identity. A changed pause kind throws.
Unbound or unrelated parts keep their ordinary mapper behavior, and genuinely
unregistered leaf tools still emit the visible unsupported-resume event.

The production stream-loop regression pairs this contract with the actual
three-process verifier. Removing the loop's preparation call fails the unit
cases rather than letting a correctly implemented helper mask missing wiring.
This does not enable interactive tools in read-only persona profiles or complete
the child-panel controls, sibling admission, or cancellation acceptance gates.

The prepared pause is deliberately a narrow input to the common pause mapper:
only decision payload/schema and transport coordinates are forwarded. Native
row IDs and provenance are read from the original part by the projection;
this prepared value is never written back to native memory or used as a stream
replacement. The observed registered leaf tool ID is retained separately from
its display name so sanitizer collisions cannot remap an already resolved ID.
A pause-kind mismatch fails visibly because substituting approval for a question
would expose the wrong decision action. It must not return an actionable wrapper
as a fallback. Pending aliases live only for this stream attempt; resume creates
a new projection, and a subsequent observed leaf replaces the prior alias. They
are not a cross-resume cache.
