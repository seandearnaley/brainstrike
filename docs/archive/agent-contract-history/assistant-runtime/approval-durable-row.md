# The pause as a durable row — evidence

Supports `docs/agents/assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)".
Read before changing the `tool.approval.requested` row, its resolution rule, or the approval/resume action wire contract. BST-1402, BST-1417.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3513-3628), extracted verbatim.

THE PAUSE IS ALSO A DURABLE ROW (BST-1402). Every approval pause writes a
`tool.approval.requested` run event to `brainstrike_assistant_run_events`
carrying the paused call's `toolCallId`. It exists so a LIST-WIDE question —
"which threads are waiting on me?" — can be answered in SQL: rediscovering
pauses from Mastra's suspended-workflow snapshot is a per-thread round trip and
cannot be run for a whole thread list. Its consumer is the Threads panel's
"needs you" projection (`use-threads-awaiting-approval.ts`, one resource-scoped
live query; see `docs/agents/assistant-persistence.md` § THREAD GROUPS). Two
properties of that row are load-bearing:
- RESOLUTION IS DERIVED AND RUN-AGNOSTIC. Nothing marks the row answered. A
  pause is resolved by the LATER existence of `tool.started` / `tool.completed`
  / `tool.failed` / `tool.resume.unsupported` for the SAME
  `metadata->>'toolCallId'`. PAIRING is on that id and never on `run_id`: the
  approve/decline resume is a SEPARATE leg that mints its own `runId` and its
  own `thread_runs` row, so the event that answers a pause always carries a
  different run id than the pause. `tool.started` counts as resolved here (a
  tool that started was approved) even though the run-timeline derivation does
  not treat it as terminal — the two ask different questions, which is exactly
  why `tool.started` needs an ORDERING guard the three terminals do not: the
  approval gate runs inside `toolCallStep`, so the PAUSING leg already emitted
  a `tool.started` for that same call before the pause row. The guard compares
  `occurred_at` (`sequence` is per-run and meaningless across the two legs).
  The SQL, the guard, and the producer shapes that make it load-bearing are
  specified once in `docs/agents/assistant-persistence.md` § THREAD GROUPS — do
  not restate the rule here. Two earlier restatements each drifted: one into the
  opposite ruling ("no ordering guard is needed"), and one into a run-scoped
  guard that a step with two gated calls defeats.
- IT DELIBERATELY IGNORES `thread_runs.status`. A leg that pauses for approval
  finishes with `finishReason: 'tool-calls'`, which every terminal writer
  records as `completed`, so a `status = 'running'` join would make the
  projection permanently EMPTY while the user's obligation and the suspended
  Mastra snapshot both outlive that row. For the same reason the startup
  run-reap does not gate it.
- AN ABANDONED PAUSE STAYS LIT (BST-1417, known). The only thing that clears
  the glyph is an outcome event for that `toolCallId`. A pause the user never
  answers — and whose suspended snapshot is later discarded — leaves the row
  unresolved forever, so its thread keeps the "needs you" glyph with no pause
  left to answer. Lighting it is the safe direction (never silently drop an
  obligation), but it is a real dead end, not a design intent to defend.

APPROVAL ACTION MESSAGES ARE BOOKKEEPING, NOT CONVERSATION: clicking
Approve/Decline (and the suspend notice's Approve/Reject/Answer) appends a user
message whose `metadata.custom` + `runConfig.custom` carry the action under
`TOOL_APPROVAL_RUN_CONFIG_KEY` / `TOOL_SUSPEND_RUN_CONFIG_KEY`, with an echo
text ("Approved <tool>." / "Approved the plan."). Approval actions are a strict
wire object: exactly the own keys `action`, `runId`, `toolCallId`, and optional
`toolName` and `hostRunId`; the two required ids and any present tool name or
host run id are non-empty and bounded by the shared 512-character
approval-transport constants. Suspend resume actions mirror that
exact-own-key and identifier contract for `resumeData`, `runId`, `toolCallId`,
and optional `toolName`/`hostRunId`; only the `resumeData` value stays
tool-defined for Mastra's resume schema. Extra own or
inherited fields, blank identifiers, and oversized identifiers are malformed.
`runId` is the NATIVE Mastra run the resume routes address; `hostRunId` is the
DURABLE host leg (`brainstrike_assistant_thread_runs.id`) the pause notice was
streamed by, copied from the pause so the history topology adapter can anchor
the suspended message on that leg's turn (see the DURABLE-PARENT INVARIANT in
docs/agents/assistant-persistence.md — the two ids are never interchangeable,
and a native run id never matches a thread-run row).
Every Desktop and Hosted Web boundary parses BOTH continuation kinds before
dispatch: either malformed action returns the corresponding
`invalid_tool_approval_action` / `invalid_tool_resume_action` HTTP 400, and two
valid actions return `conflicting_tool_continuation_actions` / HTTP 400. Hosted
Web deliberately has no tool registry or durable Mastra workflow store: both
the Vercel Preview function and Vite dev/preview return
`tool_approval_unavailable` / HTTP 409 for a valid approval/decline action and
`tool_resume_unavailable` / HTTP 409 for a valid suspend-resume action. This is
identical in local Vite and Vercel Preview so a long-lived dev process cannot
advertise continuation behavior that fails when Vercel routes the next request
to another instance. The deployable Vercel wrappers fail closed outside Preview
as `production_auth_required`; public production requires application
authentication plus distributed quota/cost controls. Hosted Web likewise
rejects every non-empty `Last-Event-ID` with
`stream_resume_unavailable` / HTTP 409 after enforcing the body-size bound;
process-local replay is not a distributed capability. Normal Web turns run
without workflow storage, so approval/suspending tools remain fail-safe omitted.
Before any Vite dev/preview assistant route reaches those contracts, its
developer-key boundary requires a loopback TCP peer, a `localhost`/loopback
`Host`, same-origin browser provenance (while permitting no-`Origin` loopback
CLI calls), and `application/json` on POST. Boundary failures are typed 403/415
responses and drain the incoming request; they never fall through to Vite or
touch the assistant runtime. Vercel entrypoints use their separate deployment
boundary rather than this local socket check.
That message is THREAD-STATE ONLY:
- The panel renders it as a compact outcome chip
  (`approval-action-chip.tsx`, `data-testid="approval-action-chip"`), never a
  prompt bubble — BOTH marker kinds: per-tool approvals ("Approved
  <tool>"/"Declined <tool>") and suspend resumes ("Approved/Rejected the plan"
  with a feedback note, "Answered: <truncated answer>"). The recognizers are
  STRICT (canonical contract guards + only the resumeData shapes the suspend
  notice actually produces); an unrecognized/malformed marker falls through to
  the ordinary bubble — content is never hidden behind a guessed chip. The
  message stays in thread state so the notices' outcome locking
  (`resolveApprovalRunOutcome`/`resolveSuspendRunOutcome`) and the resume
  `runConfig` keep working.
- The shared transport (`data-stream-runtime.ts` `run()`, both apps) excludes
  action messages (BOTH keys — `approval-action-message.ts` is the single
  recognizer) from EVERY outbound payload BEFORE
  `selectTransportMessagesForMastraMemory`, so a regenerate-after-approval leg
  anchors on the previous REAL user message instead of the echo, and
  non-memory full-history resends never replay it. Action legs themselves
  (runConfig carries either key) ship `messages: []` — the desktop and web
  resume routes read the action from `runConfig` and ignore messages. The
  transport recognizer uses the SAME strict contract guards as the chip
  (`isAssistantToolApprovalAction`/`isAssistantToolResumeAction`, keyed per
  run-config key), NOT a loose "is a record" check: wire-exclusion and
  chip-rendering MUST agree on what an action message is. A
  record-but-structurally-invalid marker (e.g. `{}`) is NOT an action — the chip
  renders it as an ordinary bubble, so the transport keeps it on the wire rather
  than silently dropping a user-visible prompt (no-silent-fallbacks). Proof:
  `data-stream-runtime.test.ts` ("keeps a record-but-INVALID … marker on the
  wire").
- Mastra never persists the echo (neither resume path passes messages), so it
  is absent after reload — restart-safe rediscovery owns the post-restart UI.
  Pinned live in `mastra-tool-approval-suspend.integration.spec.ts`
  ("never persists an approval action echo").
