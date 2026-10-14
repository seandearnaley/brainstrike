# Child conversation UI and the shared panel — evidence

Supports `docs/agents/assistant-subagents.md` § "Child conversation interaction contract".
Supports `docs/agents/assistant-subagents.md` § "Shared conversation surface".

The BST-1717 design contract and the BST-1724 shared-panel boundaries, including decision routing through the owning root.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 766–849 at commit 7c3eb8f38.

---

The planned first-class child UI is specified in
[`docs/design/subagent-threads/README.md`](../../../design/subagent-threads/README.md),
with a clickable isolated design fixture beside it and behavioral browser
coverage in `apps/web/e2e/subagent-design-prototype.test.ts`. It is a design
contract for BST-1724/1725, not a claim that the current runtime persists full
child threads or enables writable personas.

Reuse the current thread renderer, runtime adapter, activity rows, color tokens,
tabs and TreeTable adapter. A child is selected by durable conversation identity;
persona id and call sign are separate. Mount transcripts only for visible panes.
Closing a tab changes presentation only. Stopping a child stops its owned branch;
root stop covers the tree. Direct steering must acknowledge delivery and notify
the parent without rewriting a completed delegation result. Every inherited
control must have a working child-scoped command and persistence path before it
appears enabled. The linked parity matrix names the existing owners and delivery
responsibilities; BST-1728 verifies actual runtime parity.

### Shared conversation surface (BST-1724)

`AssistantConversationPanel` accepts a host-owned public `AssistantRuntime`, a
stable `threadKey`, and an accessible conversation label. It uses the same
`ChatThreadUI` as the main local/data-stream panels, including message/activity,
reasoning, rich tool/result extension points, errors, action bar, composer and
virtualized viewport. Do not introduce a second child message renderer.

The panel does not create, start or cancel an execution. The host owns runtime
creation, graph-authorized hydration and command routing. The existing-runtime
surface disables the root session queue dispatcher and its queue/steer controls
through `FollowUpQueueOwnershipContext`; a queued item cannot start work merely
because an inspection panel mounts or observes a run end. Child coordination
controls require their own host capability in BST-1723. Only mount visible
conversation panes. The runtime and all command callbacks must refer to the
selected durable conversation; disabled capabilities must be explicit. Mounting
this component alone does not implement child steering, tab navigation or
independent restored reading positions. Changing `threadKey` remounts the
panel subtree, resetting its draft, scroll and disclosure state. A switching
host must restore that view state or retain the owning runtime/draft separately;
those remain host integration work.

Runtime, detail/metadata providers, plan-mode state and error boundaries are
scoped inside each panel. Composer inputs use React `useId`, so simultaneous
panes have distinct accessible input identities. Host-provided tool-result
renderers remain available and receive the selected `threadKey` as their owner.
The existing global saved detail preference remains the default; this surface
alone does not add a new per-child preference store.

Child decisions and their queued-state indicators use the persisted root conversation ID
for the follow-up queue, matching the root panel's `threadKey`. The published
assistant-ui runtime thread ID is only a runtime registration identity; it may
differ from the persisted ID. `delegated-conversation-root.test.ts` keeps those
IDs distinct when proving live-delivery fallback and queued dispatch.

A child inspection panel never appends an approval or typed resume into its
external child runtime. Appending while that runtime reports running invokes
the runtime's cancellation path and cannot reach the owning root's live
decision transport. The app-shell supplies an explicit decision route to the
panel instead. That route validates and augments the durable child identity,
then asks the registered root owner to deliver the decision live or enqueue it
under the root thread key. The root alone decides live-versus-queue admission;
cards and the category grant strip read that same persisted root queue key
for their queued/locked state, even when the runtime registration ID differs.
Ranking also includes root-submitted user decisions so bulk grants cannot
resubmit an already dispatched approval. A rejected route stays visible, unlocks the control and
must not report delivery. Neither routed decisions nor category grants cancel
the root or selected child runtime. Once a routed decision is appended, its
pending/completed/retryable outcome also comes from that owning root thread;
the child transcript does not contain the resulting run. The provider shares
one owner-thread subscription across these readers. Outcome identities include
the owner-versus-child source and decision index so repeated incomplete runs
unlock the next retry without reviving an earlier optimistic lock.
`child-decision-owner-outcomes.test.tsx` covers both direct and delegated
approval/resume identities. The real workspace route rejects malformed input
as a promise so every control can observe failure and release its lock.

Paired runtime/DOM tests: `assistant-conversation-panel.test.tsx` proves isolated
snapshots/running state/drafts, child-only send/stop/approval routing, chronology,
reasoning disclosure, host result ownership and zero-part errors. Its browser
suite exercises the complete component with 600 messages, bounded mounting,
actual 390/900px browser viewports (800px high), both theme classes, keyboard
jump-to-latest and real Chromium reduced-motion emulation. Composer and jump
controls must fit inside the browser viewport and receive center-point hit tests;
a sized wrapper alone does not prove narrow-screen reachability. This suite compiles Tailwind using the shared theme
and package source directives, and asserts the actual grid layout is present.
Application navigation and native child binding remain app-shell/E2E work.

### Hidden child streaming work (2026-09-23)

The generic workspace keeps activated app surfaces mounted behind a hidden DOM
panel. Applied to child conversations, that left every visited child transcript
subscribed to live output, converting and rendering messages while invisible.
The focused three-child regression failed with all three subscriptions active
when only one tab was selected.

Child app surfaces now use React's `Activity` boundary keyed by the existing
workspace selection. Hidden effects and subscriptions disconnect while component
state and DOM survive. The root host continues receiving output; selecting a
child reads the latest snapshot. A plain conditional unmount would lose local
composer attachments and unconfirmed input receipts, so it is inappropriate here.
Other workspace apps retain their existing lifecycle.

`delegated-workspace-app-activity.test.tsx` verifies subscription isolation,
hidden output catch-up, and draft retention; `delegated-workspace-apps.test.tsx`
checks the actual shared child panel's existing navigation and action routes.
The shared `assistant-conversation-panel.test.tsx` also hides and restores an
unconfirmed input, verifying that explicit retry keeps the original request ID
and that hiding sends no duplicate request.

The desktop `delegated-child-tab-responsiveness.desktop.test.ts` exercises the
real host with three open child tabs, tab switching, output catch-up and an
unsent draft. Its controlled held-stream workload also passed without the fix,
so it is compatibility coverage, not red/green proof of the original latency.
The deterministic unit regression proves hidden subscription isolation; it does
not establish a latency bound for a long-running three-stream UI workload.
The final local Electron run passed in 19.9 seconds and recorded five
pointer-down-to-selected-tab double-animation-frame samples of 26.1, 28.5, 28.8,
28.9 and 26.3 ms. These samples describe that controlled workload only; they are
not a before/after speedup claim or a production latency guarantee.
