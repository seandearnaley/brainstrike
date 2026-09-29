# Permission gate resolved kind and per-step finish reason — evidence

Supports `docs/agents/assistant-persistence.md` §
"PERMISSION GATE RESOLVED KIND AND PER-STEP FINISH REASON". Read this before proposing to change the prelude emission, its metadata, or where the step finish reason is stamped.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`permission.gate.resolved` is an additive `ASSISTANT_RUN_EVENT_KINDS` member:
the permission gate a leg's Agent was BUILT with. It is emitted ONCE per fresh
root leg on the stream prelude beside `mcp.tools.unavailable`
(`makePermissionGateResolvedChunks` in `permission-gate-run-events.ts`, prelude
in `attempt-legs.ts`), and only when a policy snapshot gated the run:
`MastraAgentRuntime.permissionGate` is a REQUIRED `PermissionGateSummary | null`,
where null means no policy. Resume legs pass `preludeChunks: []` and persona
children re-gate inside `buildPersonaSubAgents`, so neither emits one.

Metadata: `policies`, `grantedCategories` (the snapshot's session grants),
`yolo`, `defaultRisk` (null when unset), `overrideCount`, `askTools` (the KEPT
ask set the live gate suspends), `deniedTools`, and `omittedAskTools` (ask tools
the storage fail-safe dropped because nothing could resume an approval). No key
may contain `session`: `sanitizeAssistantRunEventMetadata` drops such keys at
publication and at storage. Status `'completed'`, never `'running'`
(`NEVER_RUNNING`). Deliberately NOT in `isAlwaysVisibleRunEvent`: it explains why
an approval card appeared, and the card is the user-facing surface. Paired:
`permission-gate-run-events.spec.ts` (shape, detail, sanitizer survival),
`permission-gate-prelude.spec.ts` (real runtime assembly: gated turn,
storage-less omission, no policy), `permission-tool-gate.spec.ts` (denied
tools), `run-events.test.ts` and `assistant-run-timeline.test.tsx`.

`run.step.finished` metadata carries the step's own `finishReason`
(`readFinishReason` over Mastra's `payload.stepResult.reason`), so a
`length`-cut step is visible without waiting for the terminal event. It is added
at the `run.step.finished` mint (`makeStepFinishedMetadata`), NOT in
`makeStepMetadata`: that helper also feeds `run.started`, `run.step.started`,
`run.steered`, the steered `run.finished` and the stream-termination rows, and a
steered `run.finished` must not report the step's `tool-calls` while its finish
chunk reports `stop`. The reader's no-value sentinel `'absent'` is never
written. Paired: `step-metadata-finish-reason.spec.ts` and
`step-finish-reason-run-events.spec.ts` (including the steered turn).

