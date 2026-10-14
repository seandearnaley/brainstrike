# Plan mode gating — evidence

Supports `docs/agents/assistant-runtime.md` § "PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)".
Read before changing `filterToolsForPlanMode`, the local-provider gating, or the approve-exits-plan-mode seam. BST-1073.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4505-4556), extracted verbatim.

**Plan mode** (opt-in, per-request `runtimeData.planMode`): a persisted composer
toggle (`assistant-preferences-store.planModeEnabled`) sends `planMode:true` only
when on (presence-means-on, gated to the desktop data-stream transport in the
app-shell wrapper). `filterToolsForPlanMode` runs BEFORE the permission gate in
`createMastraAgentRuntime`'s tool pipeline (`runtime-assembly/tool-pipeline.ts`): it keeps risk ∈ {read, mcp} and
OMITS every edit/execute tool, so the model investigates read-only and proposes a
plan before any changes. **A suspend schema is NOT an admission ticket
(BST-1073)**: the filter used to keep any suspending tool BEFORE consulting its
risk, which was safe only because `submitPlan`/`askUser` are both classified
`read`. It became a hole the moment a mutation tool needed to suspend —
`run_python` requires a suspend schema for its per-call network escalation, and
that would have admitted an execute-risk arbitrary-code tool into plan mode.
Suspending tools now survive on their risk classification alone; an
unclassified tool still falls to `mcp`, which plan mode keeps. `manageTaskList` (`riskCategory:'read'`) DELIBERATELY
stays available in plan mode: it is thread bookkeeping (the assistant's own todo
list), not workspace/fs mutation, so the model can plan its steps while planning.
`buildDefaultInstructions(toolNameMap, {planMode})`
prepends a PLAN-MODE block. THREE-SIDED local gating (mirrors the task-list tool):
plan mode is EXCLUDED for provider `'local'` (the filter + the instruction block
+ the runtime `planModeActive` guard all check `normalizedProvider !== 'local'`),
and the composer toggle itself is HIDDEN for the `'local'` provider in the
app-shell wrapper (`selectedProvider !== 'local'`) rather than silently no-opping.
**Approve exits plan mode:** APPROVING a submitted plan clears the persisted
`planModeEnabled` toggle BEFORE the resume request is composed (via the
`PlanModeExitProvider` seam consumed by `AssistantToolSuspendNotice`), so the
resume omits `planMode` and the rebuilt runtime unlocks the mutation tools;
REJECT keeps plan mode on so the model can revise.

**Cross-reload hydration:** in-session resume works today; cross-reload resume
waits on the separate `listSuspendedRuns` feature (the data part is transient).
`AssistantToolResumeAction`'s fields are all recoverable from
`listSuspendedRuns().runs[].toolCalls[]`, so nothing here blocks it.

Paired tests: packages/agent/src/__tests__/mastra-tool-suspend-resume.integration.spec.ts
(real Agent + real PGlite: suspend→approve, reject-with-feedback, askUser
free-text + multi-select, no-storage fail-safe omit + resume-throws, plan-mode
drops edit / keeps submitPlan); the non-terminal unregistered-resume-schema
rejection, the sanitized-id-with-NO-sanitizedNameMap regression guard, and the
registered-tools-unaffected cases in `mastra-tool-approval-chunks.spec.ts`; the
settle-the-tool-card + leave-a-resumable-pause-open cases in
`data-stream-session.spec.ts`; plan-mode-tool-gate.spec.ts (registry derivation +
every real factory registered) and
`scripts/__tests__/suspending-tool-registry-contract.test.mjs` (the
control-tested reverse-drift scan); the ledger-aggregation and
run-event-hydration cases in
`packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts`;
the `isAlwaysVisibleRunEvent`, default-detail data-part, duration-pairing and
`tool.started`-stays-running cases in the UI timeline specs; the streaming +
data-part-continuity + default-instructions plan-mode specs; the desktop
assistant-server resume-dispatch tests; and the UI suspend-notice tests.

When changing this flow, update this section and the paired tests.
