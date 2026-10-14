# The two suspending tools and their transport — evidence

Supports `docs/agents/assistant-runtime.md` § "PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)".
Read before changing `submitPlan`/`askUser` payloads, resume vocabularies, renderer narrowing, or the suspend transport table. NOTE: the `@mastra/core@1.55` pin quoted below is historical; the manifest now requires ^1.64.0.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4234-4305), extracted verbatim.

Two SUSPENDING native tools pause the run DURING execution and resume with
arbitrary data, on a NEW transport that PARALLELS the approval transport (it does
not overload it). Built on `@mastra/core@1.55` tool `suspend()`/`suspendSchema`/
`resumeSchema` + `agent.resumeStream(resumeData, {runId, toolCallId})`
(re-verified at the 1.55 bump; 1.56 changes the approval half of this surface —
see the version ceiling in mastra-boundary.md).

- **`submitPlan`** (packages/agent/src/tools/submit-plan-tool.ts): takes a
  structured plan INLINE (`{title, overview, steps[], risks?, verification?}` —
  NOT an on-disk path like Mastra's builtin `submit_plan`), `suspend()`s with it,
  and on resume returns `{status, feedback?}`. Resume vocab is the builtin-
  compatible `{action:'approved'|'rejected', feedback?}` (SubmitPlanDecision).
- **`askUser`** (ask-user-tool.ts): `{question, options?, selectionMode?}`,
  resumes with the `{answer: string | string[]}` envelope (AskUserResumeData —
  an OBJECT so the 1.56+ `approved: true` rider attaches when askUser is
  ask-gated; a bare answer cannot carry the rider and would be denied by
  Mastra). The tool still accepts the LEGACY bare `string | string[]`
  (AskUserAnswer) so runs suspended before the envelope migration stay
  resumable; multi-select joins with ", ".

The renderer structurally narrows both tools' `suspendPayload` before displaying
or resuming it. An absent payload (`undefined` or durable JSON `null`) retains
the generic actionable fallback for legacy suspended runs. Core plan terms
(`title`, `overview`, and the steps array)
and the `askUser` question/options must be readable. Plan step titles and askUser
options are decision terms, so one unreadable entry makes the decision
unapprovable/unanswerable; unreadable advisory plan fields (`risks`,
`verification`, or a step `detail`) remain omitted. A present non-array option
list, an unknown `selectionMode`, or a selection mode without readable options
likewise makes the question unanswerable rather than silently changing its
interaction mode. An unreadable core payload renders a diagnostic failed alert
with a scrollable raw-payload view capped at 4,000 serialized characters. The
same bounded serialization is logged once per run/tool-call identity across
renderer remounts; the raw malformed object never bypasses that cap. The process-local
identity cache is capped at 64 entries with deterministic oldest-entry eviction;
tests reset it explicitly rather than depending on file order. The user may
safely reject an unreadable plan (never approve it). A readable question whose
choice controls drift remains an explicit failed alert, shows the bounded raw
payload, and offers a clearly-labelled free-text answer through the schema's
supported string arm; it never guesses a choice interaction. If the question
itself is unreadable there is no safe typed answer and no durable run event
explaining the dead end, so its alert remains visible and cannot be dismissed or
answered.

**Transport table (parallel to approval):**

| Layer | Approval | Suspend (this feature) |
|---|---|---|
| Stream chunk | `tool-approval-required` | `tool-suspend-required` |
| Data part | `brainstrike.tool-approval` | `brainstrike.tool-suspend` |
| Run-config key | `brainstrikeToolApproval` | `brainstrikeToolSuspend` |
| Resume action | `AssistantToolApprovalAction` | `AssistantToolResumeAction` |
| Server fn | `streamMastraToolApprovalAction` | `streamMastraToolResumeAction` |
| Mastra call | `approveToolCall`/`declineToolCall` | `resumeStream(resumeData,{runId,toolCallId})` |
| UI renderer | `AssistantToolApprovalNotice` | `AssistantToolSuspendNotice` (branches by toolName) |

Contract types + guards live in `@brainstrike/assistant-contract/tool-suspend`
(`readToolResumeRunConfigAction` returns `{invalid:true}` on a malformed action —
surfaced as a 400, never coerced).

**Stream path** (`mastra/tool-approval-chunks.ts`, dispatched from
`agent-streaming.ts`): Mastra emits `tool-call-suspended` when a
suspending tool calls `suspend()`. `makeToolSuspendRequiredChunks` turns it into
a resumable `tool-suspend-required` chunk + a tool-calls finish and STOPS at the
pause (this replaced the old `makeUnsupportedApprovalChunks` dead-end at ~936).
A native OpenRouter pause finish has zero tokens and no billed-cost field because
Mastra has not exposed that step's `step-finish` yet. Resume emits the deferred
step finish before continuing, so the resumed terminal finish aggregates the
pre-pause and subsequent step costs.
A malformed pause (missing toolCallId/runId) still falls back to the unsupported
termination so it fails visibly.

