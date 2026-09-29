# Swarm diagnostics tables — evidence

Supports `docs/agents/assistant-persistence.md` §
"SWARM DIAGNOSTICS TABLES". Read this before proposing to change the three append-only debug-pack tables or their write policy.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`brainstrike_assistant_prompt_manifests`, `brainstrike_delegated_wakeups` and
`brainstrike_delegated_live_decisions` are append-only debug-pack evidence. The
runtime never reads them and they are never runtime authority. The desktop host
writes them through `DelegatedConversationBinding.recordPromptManifest`,
`recordWakeup` and `recordLiveDecision` (`delegated-conversation-host.ts` over
`swarm-diagnostics-records.ts`); `createLiveDecisionLog` records the
`/assistant/decide` outcomes only the endpoint sees. Writers cap text
(`PROMPT_MANIFEST_LIMITS`, `WAKEUP_DIRECTIVE_MAX_CHARS`) and key-redact every
jsonb value with `redactSensitiveLogValue` before insert; the pack scrubs value
shapes at export. The host logs a failed or run-missing write with a code
(`swarm_diagnostic_record_failed`, `swarm_diagnostic_record_run_missing`,
`live_decision_log_failed`, `live_decision_log_run_missing`) and resolves, so a
database failure never fails the leg: the same policy as run-event persistence.

All three reference the ROOT host run with `ON DELETE CASCADE`. A
`child-first-step` manifest is named by the DISPATCHING thread, and its
`native_run_id` / `parent_tool_call_id` equal the invocation's
`parent_runtime_run_id` / `parent_tool_call_id`; `thread-debug-snapshot.ts` joins
it into a child's subtree through that invocation.
`brainstrike_delegated_continuations` remains the HUMAN wake-admission ledger:
never write a model wakeup into it. Storage, reset and deletion ownership:
docs/agents/database.md ("Swarm diagnostics evidence"). Paired:
`swarm-diagnostics-records.integration.test.ts`,
`delegated-conversation-host.integration.test.ts`, `live-decision-log.test.ts`,
`thread-debug-snapshot.integration.test.ts` and `thread-debug-pack.test.ts`.

