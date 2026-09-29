# Swarm diagnostics evidence rows — evidence

Supports `docs/agents/assistant-subagents.md` § "Swarm diagnostics evidence".

What each wakeup, prompt-manifest and live-decision row records, and why those rows are evidence rather than loop inputs.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 2566–2610 at commit 7c3eb8f38.

---

Every model-facing wakeup, deferral and late overlay is durable evidence for the
thread debug pack, recorded through the binding's `recordWakeup` (rows in
`brainstrike_delegated_wakeups`). `withBackgroundIdleLoop` records `idle-loop`
BEFORE the continuation streams, with the exact `describeBackgroundWakeup(ledger)`
directive the parent receives and, as invocations, the terminal events that woke
it. A parked parent leg records `deferred` and refuses to close while that record
is pending, so a rejected record fails the leg instead of vanishing.
`createBackgroundResumeStream` records `resume-leg` before `agent.stream`, and
`deferred` for a parked root. Both `withLateBackgroundResults` call sites record
`late-overlay` (`recordLateOverlayWakeup`) before approving or resuming.

Prompt manifests (`brainstrike_assistant_prompt_manifests`): a fresh root turn
records its system messages and registered tool names once (resume legs replay
the snapshotted prompt and record none; deferred tool-search tools are not
listed). The delegation-start hook records `child-first-step` with the prompt the
child receives and the instructions and kept tool names from the DISPATCHING
agent's `childPromptFacts`; a delegation dispatched by any other agent logs
`subagent_prompt_manifest_unrecorded` and records nothing, so nested worker
delegations have no first-step row yet. A child resumed within the same leg
records nothing; a parked child resumed on a NEW leg records a second row for the
same dispatch address, and the pack's `childFirstSteps` takes the earliest. A
host-prepared follow-up records `continuation` only after the running child
accepts it; waking an idle child records no continuation manifest.

Live decisions (`brainstrike_delegated_live_decisions`): the decide endpoint
records `no-live-run`, `refused` (with the host reason) and `failed` BEFORE it
answers; the running leg records `delivered` with the answered sibling task ids
and the request's policy snapshot; a remembered grant records
`remembered-answered` or `remembered-failed` after its attempt, from the parked
leaf captured once it is found. Exactly one row per outcome.

These rows are evidence, never inputs to the loop. The loop awaits each record,
and the host binding logs a failed or run-missing write with a code and resolves,
so a database failure never fails a leg (the pack's host log window captures the
code). Storage contract: docs/agents/assistant-persistence.md ("SWARM DIAGNOSTICS
TABLES"). Paired: `background-idle-loop.spec.ts` (record before stream, deferral
join), `background-late-results.integration.spec.ts` and
`background-worker-policy.integration.spec.ts` (resume-leg, deferral and overlay
rows), `late-background-results-processor.spec.ts`,
`subagent-delegation.spec.ts`, `build-persona-subagents-compat.spec.ts`,
`prompt-manifest-root-leg.spec.ts`, `live-decisions.spec.ts`,
`decide-endpoint.test.ts`, `live-decision-log.test.ts`,
`delegated-sibling-grant.integration.test.ts`,
`delegated-cancellation.integration.test.ts` and
`delegated-conversation-host.integration.test.ts`.
