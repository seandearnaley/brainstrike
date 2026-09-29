# Gate A and Gate B: how run_python's two approvals settled — evidence

Supports `docs/agents/code-execution.md` § "The run_python tool". Read this
before changing the approval path, the decline terminal, the network
suspension, the storage gate, or the network-deny integration proof. The
contract holds the rules; this file is the record of why, including the dead
pre-1.56 in-tool approval design.

- **GATE A IS THE FRAMEWORK'S PRE-EXECUTION APPROVAL (BST-1097, re-based at
  the @mastra/core ^1.57 adoption).** Under an `'ask'` policy the permission
  gate registers run_python as an ordinary `requireApproval` clone — the same
  idiom as every other ask tool — and Mastra collects the approval BEFORE
  `execute()` runs (same `tool-call-approval` chunk, card, grant surface, and
  approve/decline transport as always). Approve is consumed by the framework
  and the tool runs once; decline never reaches the tool, and **since
  `@mastra/core` 1.59 (BST-1282) the decline leg streams a `tool-output-denied`
  chunk** carrying `{toolCallId, toolName, args?, approval:{id, approved:false,
  reason?}}`. That SUPERSEDES the older "decline streams NO tool result"
  statement: Brainstrike maps the chunk (disposition `'mapped'`, decoded in
  `mastra/tool-event-mapper.ts`) to the DECLINE terminal — `StreamChunkTool`
  status `'declined'`, carrying the shared `DeclinedToolCallResult` envelope —
  so the call settles with a `toolCallResult` and its durable `tool.started`
  pairs off against a `tool.failed` row relabelled `Tool call declined`.
  Without that mapping the renderer's tool part would stay pending forever —
  the hang mastra #20886 shipped this chunk to fix. It is deliberately NOT the
  ERROR terminal: a decline queues no visible failure text and sets no
  `isError`, or a decline followed by no model text would read as "I couldn't
  complete the tool action because it failed" (see docs/agents/mastra-boundary.md,
  1.57 → 1.59). Because the envelope is `{kind: 'declined', …}`, a run_python
  decline still lands on THIS tool's own muted declined surface rather than a
  generic card. The approval card's "Declined" state still owns the primary UX,
  identical to every other ask tool; the tool's typed `declined` result arm
  remains legacy, kept only for pre-rework persisted threads. Paired tests:
  `mastra-tool-approval-chunks.spec.ts`, *"settles the declined tool call from
  the 1.59 tool-output-denied chunk instead of leaving it pending"* (mutation-
  checked: treating the chunk as ignored fails it) and *"does NOT report a
  declined tool call as a failure when the denial is the last chunk before
  finish"*, plus the envelope case in `run-python-result.test.tsx`. The
  pre-1.56 design (self-raised in-tool
  approval suspension; the flag forbidden) is DEAD: 1.56's approval rework
  consumes `{approved}` resumes before the tool can read them, and the same
  rework is what makes the flag safe — the suspend-resume transport now
  attaches the `approved: true` rider Mastra's per-leg re-check demands, so
  the flag no longer kills the tool's own Gate B resume
  (`createToolResumeIteratorFromRuntime`, agent-streaming.ts). The injected
  `resolveApprovalDecision()` (REQUIRED factory option; the desktop derives it
  from the request's permission snapshot via `resolveSelfApprovalDecision`,
  the same resolver the permission gate uses) now arms ONLY the
  direct-invocation guard: `'ask'` with no suspension channel refuses with
  `approval_confirmation_unavailable`, never an unprompted run. Resume data
  matching no known shape still refuses with `resume_unrecognized` rather
  than mislabelling transport drift as a user decision (`network_denied` is
  reserved for answers the user actually gave). Regression proof: the GATE A
  + GATE B case in `mastra-tool-suspend-resume.integration.spec.ts` asserts
  the EXECUTOR ran on the approve→allow path — final-text assertions are
  vacuous here (the scripted model prints its text regardless of the tool
  result, which is how the original defect shipped green).
- **NETWORK IS EXPRESSIBLE ONLY THROUGH GATE B (BST-1070, LIVE).** The input
  schema accepts `allowedDomains` (validated by the seam's exported
  `policyDomainSchema` — a bare `*` and single-label wildcards never parse),
  but a request alone opens NOTHING: the tool suspends with the exact domain
  list BEFORE the host is even resolved, and the policy stays `[]` unless the
  per-call escalation resumes with an explicit allow. The suspension channel
  has NO grant surface, so no session grant, per-tool override, or `yolo`
  posture ever pre-answers it; anything that is not exactly
  `{action:'allow'}` denies (`network_denied`, carrying `deniedDomains` so
  the model can rewrite offline), and a missing channel (direct invocation)
  refuses with `network_confirmation_unavailable` rather than running
  offline-with-exit-0 or granting silently. Both directions are
  mutation-proven in `run-python-tool.spec.ts`. The prerequisite that kept
  this inexpressible (suspend rediscovery across reloads) closed in BST-1084.
  - **A suspending tool is STORAGE-GATED**: without Mastra workflow storage
    `run_python` is fail-safe omitted entirely (a pause that cannot resume
    must never be armed) — which also keeps it off Hosted Web.
  - **run_python lives in the DEFERRED `execution` discovery namespace**: a
    scripted test model must load it via `load_tool` (exact name) first, or the
    ToolNotFoundError it gets is the discovery surface working, not a
    suspension bug (see the Gate B integration proof's comment).
  - **Testing the deny is easy to get VACUOUSLY right.** srt enforces
    `allowedDomains` at its HTTP PROXY, so a raw `socket.create_connection` is
    refused by the fence whatever the policy says — a raw-socket assertion
    passes identically with `allowedDomains: []` and `['example.com']`, i.e.
    it proves nothing about the policy. The integration proof uses `urllib`
    (the proxied path) and is mutation-checked: granting the domain makes it
    fail. Keep it that way.
