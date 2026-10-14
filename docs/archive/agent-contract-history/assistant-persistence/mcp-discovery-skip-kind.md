# MCP discovery skip kind — evidence

Supports `docs/agents/assistant-persistence.md` §
"MCP DISCOVERY SKIP KIND". Read this before proposing to change its emission seam, status, or always-visible membership.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`mcp.tools.unavailable` is an additive `ASSISTANT_RUN_EVENT_KINDS` member
recording that a configured MCP server contributed ZERO tools to a run —
discovery lost its 5s timeout race, or that server's `listTools` failed. Unlike
the worktree kinds it is emitted by the AGENT STREAM, not a main-process writer:
`prependMcpDiscoverySkipChunks` yields it from
`createStreamIteratorFromRuntime`, the initial-turn seam, so it reaches
persistence through the ordinary run-event chunk path.

Status is always `'failed'` and never `'running'`, so it declares no terminal
and can never leave a row spinning. It is filed under `NEVER_RUNNING` in
`assistant-run-event-pairing-contract.test.ts`; that guard's own comment notes
it can force a kind to be CLASSIFIED but cannot check the classification against
the emitter, so `packages/agent/src/__tests__/mcp-discovery-run-events.spec.ts`
asserts the emitted status directly.

It is in `isAlwaysVisibleRunEvent`, and that membership is LOAD-BEARING rather
than incidental. Run-event rows are hidden unless background activity /
Developer detail is on, so a kind added to the contract alone would still report
nothing to the user it exists for — reproducing the silent degradation it was
added to end. It passes that allowlist's "does anything else card this?" test
cleanly: the tool never entered the run's map, so nothing cards it, and the
"Tool execution failed." card the user does see belongs to the model's follow-up
call on the missing tool and names the wrong cause. Carrying no `toolCallId` it
needs no exemption from the card-suppression rule.

`AssistantRunTimeline` needs no change: it renders `label`/`detail`/`status` and
derives only a lifecycle colour from the kind prefix via `classifyRunEvent`,
which falls through to `'lifecycle'` for any kind that is not `memory.*` /
`tool.*`. As always, a kind missing from `ASSISTANT_RUN_EVENT_KINDS` is REJECTED
by `readAssistantRunEvent` and the row disappears, which is why the contract
entry is the first thing to add.

Emission scope is fresh turns ONLY. The approval- and suspend-resume legs call
`runTurnAttempts` directly, so although a resume rebuilds the runtime and
re-runs discovery, it re-emits nothing. See
`docs/agents/assistant-providers.md` for the discovery-side contract.

