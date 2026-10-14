# Parallel tool calls and approval-resume concurrency — evidence

Supports `docs/agents/assistant-runtime.md` § "Renderer stream-insulation boundary".
Read before changing tool-call concurrency, the per-tool vs run-wide approval flag, or child concurrency on an approval-resume leg. Settled 2026-09-13 and 2026-09-15.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2230-2267), extracted verbatim.

Parallel tool calls: Mastra executes tool calls within a step concurrently
(default concurrency 10; `toolCallConcurrency` loop option). Mastra forces
sequential execution when the run-wide `requireToolApproval` is set (ANY truthy
value, checked before the tools — `agent-DsRUDsS_.js:24054`) OR any active
tool carries the per-tool `requireApproval` flag / a suspend schema. The
permission engine (see PERMISSION ENGINE below) marks `'ask'` tools with the
PER-TOOL flag in its FUNCTION form (`approval-gate.ts`), which Mastra converts
to `requireApproval: true` + a per-call `needsApprovalFn`; the classification
reads the boolean, so it is exactly what the old static flag gave it, and only
the ask tool actually suspends — allowed tools still run. A run with no ask
tools stays parallel. NEVER synthesize a run-wide predicate on the initial leg
(settled 2026-09-15: it serialized every step of every run with an ask tool —
see assistant-subagents.md SESSION GRANT STOPS ASKING). The approval-resume
path sets the run-wide `requireToolApproval` (the function-form gate is
truthy, so the ROOT's resumed step is always sequential). DELEGATED CHILDREN
get no run-wide gate on their nested resume (Mastra's agent-tool wrapper
passes none), so their mode comes from the CALLED tools' flags alone — and
the child's function-form flag answers `false` whenever a remembered session
grant or the rebuilt leg's snapshot allows the tool. A parallel foreach
resume in Mastra 1.64 re-raises the step's approval for every allowed sibling,
so the two approval entry points (`streamMastraToolApprovalAction`, and the
tool-approval kind of `createChildContinuationDecisionStream` — exhaustive; a
suspend resume already runs sequentially through its suspend schema) pass
`approvalResumeLeg: true`, and `resolveChildToolCallConcurrency`
(`build-persona-subagents.ts`) builds that leg's children with
`toolCallConcurrency.limit = 1`. BLAST RADIUS: that option is run-level, so the
WHOLE resumed leg runs its child tool calls sequentially — every later step of
the resumed child and any persona delegated fresh after the resume — until the
leg ends; a per-step scope needs Mastra to expose per-step concurrency. SETTLED
2026-09-13 (do not relitigate by re-flagging the approved tool: that re-prompts
its next call and recreates the loop the grant ended). Paired tests:
`build-persona-subagents.spec.ts` (the mapping) and
`worker-delegation.integration.spec.ts` ("approving one delegated call leaves an
allowed sibling in the same step ungated"; the `true`/`edit-only` grant variants
are the regression cases, `false`/`read-only` the controls). The data-stream
mapper and UI key all per-call state by toolCallId and handle interleaving.

When changing this flow, update this section and the related tests.
