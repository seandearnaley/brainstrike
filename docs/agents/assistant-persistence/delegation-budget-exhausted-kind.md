# Delegation budget exhausted kind — evidence

Supports `docs/agents/assistant-persistence.md` §
"DELEGATION BUDGET EXHAUSTED KIND". Read this before proposing to change its projection seam, status, or metadata.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`delegation.budget.exhausted` is the breadcrumb that a delegated child's
durable budget forced its reserved summary step; without it the child tab shows
silence where the user needs "ran out of steps". The budget processor streams a
transient `data-brainstrike-delegated-synthesis` part on the synthesis step;
`delegated-stream-projection.ts` (`projectSynthesisOutcome`) turns it into ONE
run event on the owning CHILD conversation — the single published, unfinished
child on that native thread; none or several is a contract break that throws,
never a dropped row — and `persistDelegatedRunEvent` stores it like every
delegated run event, so the debug pack's `runEvents` section carries it.

Shape: `status` is always `'info'` — nothing runs, nothing pairs, and the child
still completes — so it is classified never-running in
`assistant-run-event-pairing-contract.test.ts`, and it is deliberately neither a
`.started` pair nor `run.failed`. `label` states the cap and the numbers
("Subagent step budget exhausted (31 of 32); summary reserved and truncated");
`metadata` carries `cap` (`steps` / `child-output` / `tree-output`), `limit`,
`used` (in that cap's unit), `synthesisForced` (always `true` on this path),
`truncated` (whether the model then cut the summary), `reservedOutputTokens`,
`parentToolCallId`, `personaId`, and `outputTokens` when the provider reported
it — ids and counts only. In `isAlwaysVisibleRunEvent`, LOAD-BEARING for the
reason spelled out on `mcp.tools.unavailable`: hidden at default detail it would
report the exhaustion to nobody. Paired: `run-events.test.ts`,
`assistant-run-timeline.test.tsx`, `delegated-stream-projection.spec.ts`
("projects a synthesis part") and the harness row "a child whose synthesis is
cut returns a truncated summary the root can use"
(`background-worker-policy.integration.spec.ts`). Contract:
docs/agents/assistant-subagents.md ("Child budgets are USER SETTINGS").

