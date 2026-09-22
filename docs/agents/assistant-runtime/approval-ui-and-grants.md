# Approval UI, grants and decision dispatch — evidence

Supports `docs/agents/assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)".
Read before changing the approval notice, grant actions, parked-sibling answering, decision dispatch, swarm presentation, the approvals strip, the optimistic lock, or the resume gate posture. BST-1070, BST-1723, BST-1749, and the 2026-09-14/15 rulings.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3085-3511), extracted verbatim.

4. The approval UI + resume chain (`makeApprovalRequiredChunks` →
   `tool-approval-required` chunk → `DataStreamMapper.handleToolApprovalRequired`
   → `TOOL_APPROVAL_DATA_NAME` data part → `assistant-tool-approval-notice.tsx`)
   prompts the user; approve→execute, decline→skip. Valid
   `brainstrike.executeCommand` arguments render as a selectable,
   whitespace-preserving command block plus the supplied working directory,
   workspace root, and timeout (an omitted working directory is labeled as the
   selected-workspace default). Its local guard mirrors the strict agent
   schema, including unknown-key rejection; malformed arguments show the
   existing visible preview error and unmodified raw arguments rather than a
   guessed command. File-edit previews label the target path and optional
   workspace root separately in their combined text, with an explicit
   separator; long identifiers truncate only visually while their complete
   text remains available to assistive technology and on hover. Live and
   rediscovered approvals share this component.
   `brainstrike.runSkillScript` uses a separate semantic preview that names the
   activated skill and skill-relative script while showing the explicit
   mounted root, root-relative cwd, runtime, and structured argv. It never
   presents or accepts a model-supplied absolute skill path; malformed typed
   arguments stay on the same visible raw-arguments error path.
   `brainstrike.runPython` (BST-1070 Gate A) renders the code plus
   always-rendered fact rows (internet / write / read / time limit / sandbox)
   from a server-computed `executionContext`
   (`CodeExecutionApprovalContext`, tool-approval contract): host facts the
   model's args cannot carry, derived by
   `resolveRunPythonExecutionContext` from the tool's own strict schema plus
   the constants execute() uses. It is forwarded in THREE places — stamped in
   `makeApprovalRequiredChunks`, spread through
   `DataStreamMapper.handleToolApprovalRequired`'s field-by-field rebuild
   (miss it and every LIVE approval degrades while rediscovered ones work —
   pinned by a live-transport test), and RECOMPUTED on rediscovery in
   `status-endpoints.ts` beside `riskCategory`. Fail-safe: args that fail
   strict narrowing or an absent/invalid context keep Approve/Decline but
   SUPPRESS the grant buttons (parent-side `resolveApprovalPreviewPolicy`,
   riding the existing null-`grantCategory` gating path) with a visible
   reason — no "always allow" for a call the card cannot read. Copy rule the
   fence contract forces: an empty `allowRead` under `defaultReadAccess:
   'permissive'` renders "most files on this computer", NEVER "can't read
   your files". Settled result surface (`run-python-result.tsx`, mounted by
   `tool-fallback-body.tsx`): killed ≠ completed ≠ didn't-run, non-zero exit is an
   amber finish (destructive chrome is reserved for `unavailable`), cancelled
   never renders as success or empty, and truncation is a per-stream note.
   Structurally narrowed result numbers must be safe integers (non-negative
   exit/omitted-byte values and a positive timeout) before this purpose-built
   surface renders. Malformed numbers stay on the generic tool-result path
   rather than producing `NaN`/`Infinity` UI. The card-level status maps
   cancelled/timed-out/killed to a `stopped` state
   instead of the generic green check.
   The built-in local provider admits a call to this chain only after its
   arguments parse as a root JSON object. A
   `local_tool_call_arguments_invalid` generation ends visibly with typed
   `run.failed` metadata before Mastra can create an approval snapshot; there
   are therefore no enabled Approve/Decline controls and no resume action for
   malformed Gemma output. Valid arguments are canonicalized before suspension,
   so the approval notice, durable snapshot, resumed card, and execution share
   one value.
   Alongside Approve/Decline the notice offers GRANT actions when (a) a
   `ToolApprovalGrantProvider`
   is mounted above it (app-shell wraps the panel, same outside-in pattern as
   `EditCheckpointProvider`; no provider → no buttons, capability gating) and
   (b) the approval carries a valid `riskCategory` (policy-driven ask —
   non-policy pauses never over-promise a grant): "Always allow <tool>" →
   `setToolOverride(toolId,'allow')` (persisted), "Allow <category> this
   session" → `grantSessionCategory` (session-lived), and — in a compact
   overflow menu (`approval-grant-overflow`) — "Allow all tools this session"
   → `grantAllSessionCategories()`, which grants ALL FOUR risk categories in
   ONE atomic store `set()` (a single subscriber notification, never a partial
   grant set). SETTLED: the blanket action is four category grants, NOT a
   session-yolo flag — per-tool DENY overrides still beat it (the safe
   direction), it changes no wire contract, and Settings > Permissions lists
   each granted category individually revocable plus a "Revoke all" button
   (`clearSessionGrants`). All grant actions record the grant
   FIRST, then approve the pending call through the normal resume; the
   pending call still resolves through `streamMastraToolApprovalAction`.
   TIMING (confirmed): the grant takes effect on the SAME resumed leg, not
   just the next request — `useAssistantRequestLifecycle.prepareRequestData`
   reads the permission posture FRESH from the store
   (`getPermissionToolGateSnapshotInput()`) at request-composition time,
   precisely because the grant + approve happen in one synchronous handler
   with no re-render in between (the same fresh-read pattern as plan-mode
   exit). The wrapper's reactive subscription additionally keeps later
   requests in sync. The same holds for a DELEGATED child's pause: the child's
   admitted permission snapshot contributes only its denies, so the grant lifts
   the child's `ask` on its next resume leg too (see `assistant-subagents.md`,
   deny-only ceiling, settled 2026-09-12).
   PARKED SIBLINGS (settled 2026-09-14, BST-1723): a session grant is a policy
   change, and the canonical behaviour (Claude Code's queued permission
   prompts) is that every prompt the new rule answers is answered. The approval
   leg therefore resumes, in the SAME leg, every parked BACKGROUND sibling whose
   pending leaf tool the runtime's fresh snapshot now allows
   (`findGrantedBackgroundApprovals`: enforced policy, tool registered, not in
   the ask set). Each sibling is walked from its DISPATCH address through the
   binding's `resolveParkedInvocation` (the desktop's read-only reload
   discovery, `createDesktopDelegatedSuspensionResolver`) because no leaf
   identity exists yet and `resolveToolAction` refuses a bare address by
   design (`tool-action-leaf-identity-required`; thread-22c3279b, where the
   agent fixture's lenient resolver hid exactly that refusal — the fixture now
   refuses like the host). Each is then durably claimed exactly as a click
   would be — EXCEPT that a policy answer never takes a claim. DECISIONS
   DURING A RUN (settled 2026-09-14, thread-b3cea1f6): the installed
   assistant-ui runtime CANCELS the in-flight run when a message is appended,
   so answering a second card while the first card's resume leg ran aborted
   that leg three seconds in (`mastra_agent_stream_aborted`) and lost the
   second click. Every decision — the approval notice, the typed-resume
   notice, and a child view's decision routed through the owning root — now
   goes through `submitDecisionOrQueue` (`decision-dispatch.ts`): idle thread
   → append; running thread → the host's LIVE transport first
   (`LiveDecisionProvider` / `useDeliverLiveDecision` → desktop
   `POST /assistant/decide`, which applies the decision INSIDE the running leg:
   see assistant-subagents.md "LIVE DECISIONS"), and only when no leg is live
   for it (404) or the host has none (web) → the follow-up queue
   (`enqueueMessage`, chip + "Queued" chip on the card, removable = veto),
   dispatched one per run end by `FollowUpQueueBridge` exactly like a typed
   follow-up. The host serializes the resulting legs. `submitDecisionOrQueue`
   is async and reports `'delivered' | 'queued' | 'sent'`; a transport
   rejection (409 host refusal, 500) propagates so the card unlocks and shows
   `Decision not sent: <reason>` inline (`sendError`, `role="alert"`). BOTH
   notices report it — the approval notice (`use-approval-notice-state.ts`) and
   the typed-resume notice (`useSuspendResume` in
   `assistant-tool-suspend-notice.tsx`) — for that rejection and for a
   synchronous `thread().append` throw (e.g. an unavailable thread scope). The
   installed assistant-ui `thread().append` returns `void` and rethrows any
   failure other than `MessageNotSentError` from a detached handler (it reaches
   `unhandledrejection`), so neither notice wraps it in a promise: a failed
   resumed run is observed through thread state (`incomplete` → `retryable`
   unlocks the card; `ErrorPrimitive` renders the error). The swallowed
   `MessageNotSentError` is the runtime's own rollback signal and is raised
   ONLY when a thread-list initializer rejects (`RemoteThreadResource`); the
   desktop/web `useLocalRuntime` in `data-stream-runtime.ts` wires none, so
   that branch is unreachable here — adding a remote thread list would make it
   reachable and would need its own observation channel, because `append`
   reports it to no caller. Both notices clear `sendError` when a new submit
   starts; beyond that a spent message never outlives its context, by two
   routes. The approval notice DERIVES the alert: the failure carries the
   run-outcome key the attempt was made in, and that key names the DECISION it
   was resolved from (its index) rather than `action`/`state` alone — two runs
   both reach `retryable`, so on the pair alone a spent message would re-match
   the second — leaving no effect to adjust it and no frame showing stale text.
   The typed-resume notice clears `sendError` on the `pending`/`completed`
   transition (this card's retry, or the same pause answered from the delegated
   child view). Paired:
   `follow-up-queue-store.test.ts`,
   `assistant-tool-suspend-notice-send-failures.test.tsx`,
   `assistant-tool-approval-notice-panel.test.tsx` (the top-level describe for
   the derived alert; "while a run is active" for the queue/transport paths),
   `assistant-ui-append-contract.test.ts` (the `void` return itself — a version
   bump that returns a promise fails type-check, not at runtime),
   `follow-up-queue.behavior.test.tsx` (real local runtime dispatch of a queued
   decision) and app-shell `delegated-conversation-root.test.ts`. SETTLED
   2026-09-14 (thread-796a942d): the decision ledger permits ONE `claimed`
   row per root (partial unique index, the serialization rule for user resumes
   across reconstructed runtimes), so claiming siblings in the same leg is
   refused with `tool-action-already-consumed-or-root-busy`. The host records
   a policy answer through `recordToolActionAnswers` directly as `consumed`
   under the leg (same admission guards; the unique leaf key still refuses a
   second answer; the child's history is frozen as `prepareToolAction` does).
   ALL OR NONE (BST-1749 review): every answer a leg records at once — a live
   user decision and each sibling its grant answers, after every leaf passes
   the native freshness check — is ONE host transaction (the binding requires
   `database.transaction`), and it names each leaf at most once. A refused
   answer records nothing, so the user's own pause stays answerable instead
   of consumed, unresumed and refused on every retry. ALREADY ANSWERED OR
   STOPPED IS NOT A REFUSAL (PR #3209 review and its follow-up): discovery
   skips a parked sibling the write would refuse for a reason of its OWN.
   `readUnanswerableToolActionLeaves` names both — `'answered'`, the leaf
   already carries a durable decision (claimed, consumed or interrupted;
   those states are ENUMERATED in the read, not "any row", so a widened CHECK
   fails loudly on the write instead of silently over-skipping a leaf that is
   still answerable), and `'stopped'`, the leaf's thread chain carries a
   cancellation request for this turn (the chain, because `scope: 'child'`
   marks only the named child's invocation row). Either way this grant owes
   the sibling nothing, and refusing over it re-conflicted on every retry that
   still carried the grant. A stopped subtree whose task is still SUSPENDED is
   reachable, not a test artefact: `handleDelegatedCancelRequest` commits the
   admission revocation before `cancelStoredBackgroundInvocations` flips the
   task, with no shared transaction and a 503 that leaves the revocation
   committed, and the startup reaper repairs `pending`/`running` tasks only.
   Both writes and this read build that stopped predicate from ONE
   `stoppedSubtreeExists` fragment, so the skip cannot be narrower than the
   write (the permanent refusal returns) or broader (a sibling the write would
   have answered is skipped and its task stranded).
   ROOT-WIDE admission (the root run not running, cancelling or cancelled)
   stays fatal for the whole write — it refuses the user's own answer too —
   as does a leaf answered or stopped in the WINDOW between that read and the
   write, now the only fatal per-sibling refusal. Paired: desktop rows "a live
   grant skips a sibling another decision already answered and still delivers
   the user's own answer", "a live grant skips a sibling whose subtree was
   stopped and still delivers the user's own answer" and "a live grant refused
   on a sibling answered inside the write window records nothing: the user's
   own card stays answerable".
   The agent fixture now holds one active claim and refuses a second, exactly
   like the host, and `delegated-runtime.integration.test.ts` ("a session
   grant answers the parked background sibling through the real host ledger")
   runs the whole flow through the REAL desktop host, ledger and background
   store — the proof every host-boundary change must carry from now on (three
   lenient-fixture misses in one day: resolve, claim, background scope). The
   leg streams
   one `tool-approval-answered` chunk per sibling. The mapper ships it as the
   `brainstrike.tool-approval-answered` data part; the notice scans the thread
   for a part with its own identity key and locks as "Allowed by session grant".
   Neither the request part nor the answer part is stored with the message:
   after a reload of a finished turn the answered rows are gone, and only a
   leaf that rediscovery still finds suspended gets a card back, rebuilt with
   its durable decision state (`assistant-memory-repository.ts`; verified live
   2026-09-15 on run 21: 755 hydrated parts, no approval parts). A mid-run
   reload replays the session buffer, answers included. A
   one-shot Approve changes no policy, so the ask set still holds the tool and
   siblings stay parked. Foreground siblings (no background scope: web) remain
   one Mastra `approveToolCall` leg each by the framework's own resume model.
   The root card itself exists for BACKGROUND children only because the leg's
   publish seam synthesizes it (`withRootPauseNotices`, see
   `assistant-subagents.md`): nothing native suspends the parent run when a
   background task parks, and the parent-level pause Mastra writes on a
   still-open dispatching turn is dropped as a second delivery (ONE DELIVERY
   PER BACKGROUND CALL, `assistant-subagents.md`).
   The delegated notice also NAMES its child — persona label plus the prompt
   the root gave it (`describeDelegationOwner`) — so four identical read
   prompts from four specialists are distinguishable. Both the name and the
   host answer come from ONE incremental thread index
   (`answered-approvals-index.tsx`, mounted over the thread in
   `assistant-ui-panel.tsx`), never from a per-card selector that walks every
   message part on every store update: during a fan-out the root assistant
   message accumulates one data part per child chunk, so a per-card walk is
   O(parts) × cards × updates and the renderer stalls while four children
   stream (2026-09-14, "the app locks up while processing"; the main process
   kept serving and the durable log showed nothing). The main process now logs
   `renderer_unresponsive` / `renderer_responsive_again` with timing
   (`create-window.ts`) so a hang is durable evidence next time. Grants are offered in the child views too
   (`useToolApprovalGrantHandlers` mounts the provider over the workspace).
   Paired: `background-worker-policy.integration.spec.ts` ("answers every parked
   background sibling" / "one-shot approval answers only its own"; mutating the
   gate either way fails one of them), `data-stream-approval-answered.spec.ts`,
   `assistant-tool-approval-notice-panel.test.tsx` ("for a delegated child").
   SWARM-AWARE PRESENTATION (settled 2026-09-15 with Sean, do not
   relitigate): the thread shows ONE full approval card per risk category
   while a decision is pending; every approval already answered — the host's
   `tool-approval-answered` (`session-grant` or `user`), a durable
   `decisionState`, the user's own appended decision, a decision queued
   behind the run, or a click in flight — and every pending approval BEHIND
   its category's card renders as a one-line row (`approval-row.tsx`) whose
   expanded body is the full card (locked when answered, actionable when
   merely behind the card). A row for a durable `decisionState` (claimed,
   consumed, interrupted, cancelled, invalid) ALSO renders its recovery status
   (`RediscoveredPauseLines`, `delegated-decision-recovery-status`) under the
   collapsed line, and the embedded card omits it so it renders once: that
   status is safety information ("Processing stopped and the outcome is
   unknown. Check the workspace before starting another action.") with no
   control beside it, so it must be readable without opening the row. The
   first row cut rendered it only inside the expanded body, hiding an
   interrupted decision's warning (2026-09-15; the reload integration test
   caught it). Pending-since and stale lines stay in the card, beside the
   actionable controls. The choice is pure (`approval-presentation.ts`:
   `resolveApprovalPresentation` over `answered` + the per-category pending
   rank) and the rank is computed ONCE per thread change by
   `ApprovalRanksProvider` (`approval-presentation-context.tsx`) from the
   SAME incremental index, which now also records every request part and
   user decision — never a per-card walk. Delegation identity is a colour
   rail hashed from the delegation call id (`delegation-colour.ts`,
   `--bs-delegation-1..8`), one rail per ancestor edge plus a depth indent,
   NOT DOM re-parenting: approval parts stay standalone in the assistant
   message (ACTIVITY GROUPS ruling). Both forms carry
   `data-testid="assistant-tool-approval-notice"` and
   `data-approval-presentation="card|row"`; `approval-delegation-owner`
   names the persona chain ("Explorer › Analyst") on the row and the same
   chain + the root prompt excerpt on the card (`describeDelegationOwner`
   builds its label from `describeDelegationChain`, so a depth-1 card still
   reads "Explorer · <prompt>"). The notice file is a chooser;
   `use-approval-notice-state.ts` owns the outcome/lock/submit logic and
   `approval-preview.tsx` the structured previews.
   OPTIMISTIC LOCK (2026-09-15): the lock a click takes is STAMPED with the
   run outcome it was taken in (`ApprovalRunOutcomeKey`) and DERIVED during
   render — never adjusted in an effect. It holds while the thread still
   reads that outcome: the double-click window, and a live decision delivered
   INTO the running turn, which appends no message at all and so keeps the
   card locked for good. It is spent as soon as the outcome moves on, which
   is how a FAILED (`retryable`) resumed run hands the card back. The two
   halves pull against each other and BOTH need the key to be an IDENTITY,
   not a value:
     - Testing `state !== 'retryable'` directly — as the effect this replaced
       did, `submittedAction` being in its own dep array — DROPS the lock a
       RETRY click has just taken, because the thread still reads the run
       that failed until the retried decision reaches it; the second of two
       quick clicks then appends a duplicate decision (the DECISIONS DURING A
       RUN hazard, one layer up).
     - Keying on `{action, state}` alone RESURRECTS a spent lock, because
       that pair repeats: approve → fail → retry approve → fail again reads
       `approve`/`retryable` both times, and the card locks with no way back.
       `resolveApprovalRunOutcome` therefore also reports `decisionIndex`
       (the index of the decision message the outcome describes, `-1` for
       none) and the key carries it.
   Pinned as a PAIR by `assistant-tool-approval-notice-panel.test.tsx`
   ("locks the card from a retry click the thread has not caught up with
   yet" and "reenables approval actions when the retried run fails the same
   way"); neither alone is enough, and both must stay green beside the
   existing `retryable` re-enable cases.
   Paired:
   `approval-presentation.test.ts`, `approval-presentation-context.test.tsx`,
   `approval-row.test.tsx` (card→row on a host answer, promotion of the next
   pending card, nesting depth/rails/chain, an answered click collapses, a
   durable decision state keeps its recovery status on the collapsed row
   exactly once), app-shell `delegated-child-reload.integration.test.tsx`
   ("keeps rich persisted history visible while an interrupted exact decision
   stays non-actionable": the status before the row opens, the locked buttons
   after),
   `approval-row.browser.test.tsx` (per-theme rail colour), and the
   expand-before-assert edits in the existing approval tests.
   APPROVALS STRIP (same ruling): `approval-queue-strip.tsx` sits at the
   composer beside the follow-up chips and lists the PENDING approvals per
   risk category from `usePendingApprovalsByCategory` (the same ranks
   provider). "Allow <category> this session" records the session grant
   FIRST and then submits ONE approve — for the first pending approval of
   that category — through `submitDecisionOrQueue`, byte-identical to the
   card's button (`buildApprovalDecisionMessage`): the runtime answers the
   siblings (PARKED SIBLINGS / `allowedBySnapshot`) and their
   `tool-approval-answered` parts collapse their rows. It never submits N
   decisions (one active ledger claim per root). Capability-gated like the
   card: no `ToolApprovalGrantProvider` → counts only. Non-policy `tool:*`
   buckets are never listed. Its button label ends "…for the N waiting
   approvals" on purpose: the live verifier selects a CARD's grant by
   `[aria-label$="for this session"]`. Paired:
   `approval-queue-strip.test.tsx` (counts, one decision, idle append,
   round-trip lock, capability gating).
   CHILD VIEWS READ THE ROOT'S ANSWERS (settled 2026-09-15): a delegated
   child tab renders its OWN copy of a leaf approval (the child stream's
   notice), but the host publishes `tool-approval-answered` on the ROOT leg
   only (`live-decisions.ts`, `recordGrantedBackgroundApprovals`); a child's
   task channel carries child output, never host facts (ONE DELIVERY PER
   BACKGROUND CALL, `assistant-subagents.md`). An index over the child's
   thread alone left every read the grant answered "Pending" with live
   buttons in each child tab while the root showed "Allowed by session
   grant" rows (GLM fan-out of four Explorers, 2026-09-15). The child view
   therefore reads its owning root's answers BY IDENTITY (the child notice,
   the root card and the answer share `getToolActionIdentityKey`): the
   delegated conversation root publishes its registered runtime thread
   (`getOwnerThread` / `subscribeOwner`, `delegated-conversation-owner.ts`),
   `ChildView` passes it as `ownerThread` to `AssistantConversationPanel`
   (`ApprovalOwnerThreadContext`), and `AnsweredApprovalsProvider` indexes
   the owner's messages incrementally beside its own and folds in ONLY
   their answers — requests, delegation prompts and user decisions stay the
   view's own, so a child's ranks and strip never list root or sibling
   approvals. No second writer and no second delivery: the root stream
   stays the only place an answer is published, native memory the only
   child transcript writer. A genuinely pending child card keeps its
   buttons (its decision routes through the owning root). A child view with
   no registered owning runtime reads no root answers; its decisions already
   fail at dispatch ("The owning conversation is not available"). After a
   reload a child has no live leg and shows a leaf approval only while
   child rediscovery finds it suspended, locked by its durable
   `decisionState`. Paired: `child-view-owner-approval-answers.test.tsx`
   (two real external-store runtimes; the child view is memoized, so a root
   update reaches it only through the subscription — mutations: dropping
   the owner merge fails the three answered rows, an owner subscription
   that never notifies fails only the live row), app-shell
   `delegated-conversation-root.test.ts` ("publishes the registered owning
   thread…"; mutations: no notify on register, no notify on retire) and
   `delegated-child-reload.integration.test.tsx` ("shows a child approval
   its owning root already answered…" through the real `ChildView`;
   mutation: no `ownerThread` renders the pending card).
   An OpenRouter approval pause terminates its transport leg with zero-token
   usage and no claimed cost: Mastra emits the pause before that model step's
   `step-finish`. Approval resume emits the deferred step finish before later
   steps, so normal terminal aggregation records the exact total then.
   Management surface: Settings > Permissions lists per-tool overrides
   (change decision / remove via `setToolOverride(id,null)`) and active
   session grants (revoke via `revokeSessionCategory`). The chunk carries an optional
   `riskCategory`/`policyDecision` so the notice can name the reason. The
   data-stream mapper correlates Mastra's transient tool error emitted before a
   deliberate `suspend()` and suppresses only that call's false failure fallback;
   unrelated tool failures remain visible. Before either approval decision is
   applied, the resume adapter reads Mastra's storage-backed
   `listSuspendedRuns()` snapshot and exact-matches both `runId` and
   `toolCallId`. That durable snapshot is the authority for the original tool
   name and arguments. The resumed stream is seeded with that exact invocation
   before terminal output is mapped, so live completed cards retain the same
   arguments shown by the approval notice. A missing snapshot, tool name, or
   argument payload fails visibly before approve/decline executes; never invent
   `{}` or trust the client action as a fallback. Runtime reconstruction also
   reads Mastra's durable suspended-call snapshot before runtime reconstruction
   and preserves the execute-backed `brainstrike.webSearch` implementation only
   when that exact call is being resumed. A same-click read grant changes
   authorization immediately, but must not replace the suspended Tavily function
   with provider-native search: Mastra's durable invocation names the function
   and otherwise finishes without executing it. Resuming a different tool keeps
   provider-native search available, and a fresh later turn may select it. The
   approve/decline resume (`streamMastraToolApprovalAction`) passes
   `requireToolApproval: true` (the resume API needs it); the gate runs again on
   resume so the ask tools keep their per-tool flag. Because run-wide
   `requireToolApproval: true` would suspend EVERY tool call on the resumed leg,
   `resolveRequireToolApproval` (`approval-gate.ts`) substitutes the runtime's
   live predicate (`runtime.approvalGate`), backed by the rebuilt runtime's
   authoritative `askTools` set and the leg's remembered grant. Allowed
   read/internal-state tools keep running, ask-gated mutations may suspend again,
   and the canonical Mastra internal ids (`internal-approval-exempt-tools.ts`:
   `updateWorkingMemory`/`setWorkingMemory`) remain explicitly exempt — as are
   the SELF-APPROVING suspending tools (BST-1097), but ONLY from the ASK-SET
   half: re-gating one there would make Mastra consume its `{approved}` resume
   before the tool sees it, so the tool re-runs with no resume data and
   suspends Gate A again — an approval loop that can never complete. The
   EXPLICIT GLOBAL posture still gates them: with `permissionEnforced ===
   false` there is no snapshot, the injected decision resolves `'allow'`, and
   the in-tool gate is inert — exempting them there would make run_python the
   one execute-risk tool a global approval request never prompts for (and the
   loop cannot occur, because the inert self-gate never re-suspends after the
   framework consumes the approval). The symmetric transport rule also
   holds: `streamMastraToolResumeAction` verifies via
   `assertResumedCallIsSuspendPause` that the targeted call is suspended on a
   PLAIN `suspend()` pause (`requiresApproval === false` in the snapshot) —
   a generic resume payload must never answer an approval pause, mirroring
   `readResumedApprovalToolCall`'s `requiresApproval === true` requirement in
   the other direction. An EMPTY
   `askTools` on the resumed leg is AMBIGUOUS and is disambiguated by the
   runtime's `permissionEnforced` flag (`permissionSnapshot !== undefined`),
   NOT by `askTools.size` alone:
   - **A policy WAS enforced (`permissionEnforced === true`) but resolved nothing
     to `'ask'`** — every remaining tool is ALLOWED, e.g. after "Allow all tools
     this session" grants all four categories (denied tools were already omitted
     from the map). This is an all-allowed posture: the resume gate gates
     NOTHING, so a later mutation tool in the SAME resumed run is NOT re-prompted.
     (Without this, granting all categories then approving re-prompted every
     subsequent tool — the opposite of "allow all this session".)
   - **No policy was enforced (`permissionEnforced === false`) yet the caller set
     run-wide `requireToolApproval: true`** — a genuine explicit GLOBAL approval
     request (the pre-permission-engine behavior); the resumed leg keeps gating
     every non-internal tool.
   Per-tool DENY still wins in both cases: a denied tool never enters the gated
   map, so it never reaches the resume gate. A non-empty `askTools` always gates
   exactly the ask set regardless of posture.
