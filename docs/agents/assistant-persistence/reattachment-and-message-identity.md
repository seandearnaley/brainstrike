# Reattachment records and message identity — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the ephemeral reattachment record, the durable-status reconciliation, or the id alignment chain.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

   The UI transport preserves each assistant-ui user message id through the
   generic-message conversion, and the desktop request parser preserves
   assistant-ui's `unstable_assistantMessageId`; the stream session and Mastra
   id generator both use those validated ids for the persisted user/visible
   assistant pair. A normally finished stream asserts that the one-shot Mastra
   generator consumed the assistant id through its memory message context,
   making upstream contract drift visible instead of quietly substituting a
   UUID. Initial turns and both approval/suspend resume paths pass a separate
   per-call stream-id generator with the same initial id; the Mastra-global
   generator remains reserved for the persisted memory row, so a transient
   resume stream id cannot consume the durable identity first. If
   observational-memory sealing creates additional snapshot rows,
   hydration keeps the topology-bearing row's id for the combined assistant-ui
   message. A new topology-bearing assistant id always starts a new hydration
   group, including after an open legacy group, so consecutive regenerated
   responses remain carousel siblings rather than being mistaken for snapshots
   of one response.
   This end-to-end identity alignment is what lets a later edited prompt point
   to its durable assistant parent without correlation heuristics.
   Desktop generation continues in the main-process data-stream session when a
   renderer response detaches. Once a valid desktop response admits the server
   session, renderer completion callbacks release local leases and usage context
   without writing a durable terminal status, including on network disconnect.
   Failures before session admission still terminate the renderer-prepared run;
   successful explicit Stop leaves terminal persistence to the host cancel path.
   Desktop tests that mock the host response and seed completed history must
   also seed the exact prepared run's completed status; replay headers transfer
   ownership even in a transport mock. The delegated-workspace reload fixture
   checks the exact run/resource/thread update before inspecting idle history.
   The durable run row is updated only after that
   session closes. Its mapper-owned terminal outcome is authoritative for
   abnormal model finishes: an output-limit or missing-finish terminal state is
   stored as `failed` with the bounded visible error, while only explicit
   `POST /assistant/cancel` records `cancelled`.
   Renderer reload reattachment is deliberately ephemeral rather than a second
   durable run store: thread-scoped `sessionStorage` holds the server session's
   opaque replay cursor, durable run id, and durable assistant message id only
   while the main-process session is active. Reload hydrates persisted history
   first, then replays that exact session through `GET /assistant/resume` into
   the same assistant message and persisted parent; it does not create a
   duplicate branch, another run row, or resend model input. Completion,
   failure, Stop, a visible expired-session response, replay retry
   exhaustion, and the stale-record reclaim below remove the ephemeral
   record. The record is a HINT, never a second authority: before the
   "awaiting stream reattachment" guard rejects a new run, `prepareRequest`
   reconciles the record against the durable run row through
   `GET /assistant/run-status` (the same authority as the BST-1244
   Threads-panel projection) — a terminal or missing durable run reclaims
   the record with a logged warning and the new run proceeds; only a
   genuinely `running` durable row keeps the guard, and a failed probe keeps
   the guard (fail-safe, never a silent reclaim). Replay failures that
   exhaust the retry budget run the SAME durable-status reconciliation:
   the record is released only when the run is provably over, and KEPT
   while the durable row still says `running` — the main-process stream
   continues after renderer detachment, so an unconditional clear would
   let the next send start a second concurrent turn against the orphan
   (Codex review, #2510). Keeping it cannot wedge the thread anymore: the
   next send's reconcile heals once the run ends (2026-08-18 field
   failure: a dev-mode renderer reload mid-stream orphaned a record whose
   run finished seconds later, and every send until app close was
   rejected). The
   expired-resume 404 is logged server-side so "expired" and "never
   attempted" are distinguishable in diagnostics. The public assistant-ui runtime temporarily creates a generated
   streaming leaf; the client removes the hydrated durable leaf before replay,
   remaps the history append to the durable ID, and after `runEnd` remaps the
   generated local ID through thread `export`/`import`. Waiting for `runEnd`
   preserves assistant-ui's final error/incomplete state before identity
   reconciliation. This keeps Mastra's durable content identity and
   assistant-ui's parent graph aligned without a package patch. Missing leaves
   and leaves with descendants fail visibly.
   While this graph is loading, `ChatThreadUI` disables every composer send
   path using assistant-ui's `state.thread.isLoading`. The installed runtime
   captures a new message's parent from the current in-memory tail before its
   async append waits for history initialization; allowing a send against the
   initial empty snapshot would therefore persist an explicit `null` edge and
   replay a normal continuation as a root carousel revision. Draft text remains
   intact and sending re-enables when hydration settles. The real-runtime
   regression pin is `history-hydration-composer.behavior.test.tsx`; existing
   repository integration cases continue to pin genuine prompt edits and
   regenerated responses as siblings.
   Hydration must also not YANK the viewport: `ThreadPrimitive.Viewport` keeps
   `scrollToBottomOnInitialize={false}` and `scrollToBottomOnRunStart={false}`,
   so reopening a thread restores where the reader was instead of jumping to
   the newest message. Live auto-follow, the jump-to-latest affordance, and the
   pinned-only `overflow-anchor` opt-out are the viewport store's business —
   see assistant-runtime.md § THREAD SCROLLING. Above the virtualization
   threshold those two props no longer describe the opening position on their
   own: the virtualized tier has no library initialize step and anchors to the
   newest message itself, without animation, and only when the reader was not
   already scrolled up — same section. The stance is pinned by the BST-896 and
   BST-897 cases in `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts`.

Approval/suspend ACTION messages are deliberately NEVER a Mastra row: the
"Approved <tool>." / "Approved the plan." user message the notices append is
UI/transport bookkeeping (its `runConfig` drives the resume; its metadata
marker drives the notice outcome locking + chip rendering). Neither resume
path passes messages to Mastra, and the shared transport
(`packages/assistant-ui/src/data-stream-runtime.ts` +
`approval-action-message.ts`) excludes action-marked messages from every
outbound payload and ships `messages: []` on the action legs. Consequences:
the echo is absent after reload (restart-safe rediscovery owns the
post-restart approval UI — see assistant-runtime.md PERMISSION ENGINE), and a
regenerate-after-approval resends the previous REAL user prompt, never the
echo. Live pin (real Agent + real PGlite): the "never persists an approval
action echo" case in
packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts —
if a Mastra writer ever starts persisting the echo, extend the exclusion at
that writer and update this section.

The September 2026 hosted-run fast follow moved active-run discovery into a
per-attempt external resource subscribed through `useSyncExternalStore`. An
effect starts and disposes the resource; it owns the timeout, abort signal,
cached snapshot, and generation fence. The controller checks cancellation
before executing after StrictMode's throwaway mount, and reconciliation checks
the signal again before storage or session writes. This preserves the existing
visible Retry path without fetching or setting asynchronous discovery state
inside a React effect. A retained closed session from a prior run is checked
for terminal status before a headerless new POST is deemed conflicting; a live
same-run response is not reclassified as replay by a late discovery result.
The races are pinned by `assistant-run-discovery-resource.test.ts` and
`assistant-run-session-races.test.tsx`.

The review of PR #3302 found that an inline `authHeaders` callback could
recreate the discovery resource on every render. Starting each replacement
published an identical pending snapshot, producing a render loop even though
the thread and explicit retry had not changed. Discovery now keys its resource
only to that semantic attempt, reads the latest auth callback when the attempt
starts, and avoids notifying subscribers for an unchanged pending snapshot.
Status probes within discovery use the same abort signal as the active-run
request, so disposal stops in-flight work as well as fencing later state
changes. The bounded inline-callback and pending-notification regressions are
in `assistant-run-session-races.test.tsx` and
`assistant-run-discovery-resource.test.ts`.

CodeRabbit's final review of PR #3302 found a separate ownership race: while
the original resource's headerless POST was awaiting discovery, changing the
resource without remounting the hook let the new resource's empty result mark
the old POST failed. The production panel remounts on thread-key changes, but
its memory resource is a separate prop. Preparation captures that resource
scope before asynchronous work; a later transport error reads the captured
scope even if the renderer already switched resources. The pending failure
retains it; another or missing scope reports a visible
recovery error without querying that host or releasing the old lease.
Returning to the original scope runs discovery again and settles only from
that result. The same-hook switch, return, and late old-attempt result are pinned in
`assistant-run-session-races.test.tsx`.
