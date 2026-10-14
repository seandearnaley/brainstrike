# Tool-call token telemetry — evidence

Supports `docs/agents/assistant-persistence.md` §
"TOOL-CALL TOKEN TELEMETRY". Read this before proposing to change the two recording methods, subagent attribution, or the measurement-fidelity caveat.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`brainstrike_tool_call_telemetry` (migration 083 in BOTH runners) stores one
row per observed final model projection. The model-output observer accumulates
tool id, actual serialized model-facing characters, generic/typed truncation,
and search-only zero-match/pagination booleans; a run-end internal stream chunk
hands those samples to the desktop main-process persistence capability. The
writer derives `thread_id` from the renderer-created run row with
`INSERT ... SELECT`, warns without failing the turn on a missing run or write
failure, and never accepts raw input/output fields. The renderer lazy-bootstrap
mirrors migration 083 byte-for-byte because its thread-delete CTE references
every registered sidecar unconditionally, even though it never writes rows.

Subagent/persona-delegated tool calls attribute to this same table under the
PARENT run's `run_id`/`thread_id` (BST-1196): `agent-runtime.ts` projects the
child tool map through the SAME `RunTokenDiagnostics` INSTANCE as the primary
tool map, but via a distinct telemetry-only method,
`recordSubagentToolOutput` (`token-measurement.ts`), NOT the primary map's
`recordModelOutput`. The two intentionally diverge: `recordModelOutput` also
feeds the run's `#projection` aggregate (`modelVisibleProjection*` in
`toLogFields`), which reconciles against `promptTokensSummedAcrossSteps`
(logged name; the lifecycle field is `providerReportedPromptTokens`, the
per-leg SUM across steps — spend, not a single request's context size, which
is `latestStepPromptTokens`; the 2026-08-23 "context explosion" was this sum
misread as one request). A subagent tool output never
enters the parent's prompt (only the delegation's final result does), so
routing it through `recordModelOutput` would inflate that aggregate for every
delegating run without a matching change in the prompt sum.
`recordSubagentToolOutput` pushes only the `ToolCallTelemetrySample`, leaving
`#projection` untouched. Both methods feed the SAME `#toolCallTelemetry`
array, so samples from either path ride the existing run-end
`tool-call-telemetry` drain with no new `StreamChunk` type or schema change.
The table currently has NO origin discriminator beyond each sample's
`toolId`; a per-persona/per-origin breakdown would require a migration and
remains deliberate future work, not implemented.

Measurement-fidelity caveat: the persona/subagent tool map is built from
`guardedTools` (pre-`settleRuntimeToolOutputs`), while the primary tool map is
built from `artifactSettledTools` (post-settlement) — see
`runtime-assembly/tool-pipeline.ts`. When a `runId` is present (desktop,
`stream-init.ts`), a parent call of a large-result tool like
`brainstrike.grepSearch` is measured against its settled, durable-artifact
page, while a CHILD call of the same tool on a comparably large result is
measured against the unsettled inline projection (bounded by
`MAX_MODEL_TOOL_RESULT_CHAR_BUDGET`). Both land in
`brainstrike_tool_call_telemetry` keyed only by `tool_id`, so the shipped
`token-spend-by-tool` lens's `avg_model_facing_chars` and
`truncation_hit_rate` blend settled and unsettled samples for that tool with
no way to separate them. This is a caveat on top of (not a substitute for)
the missing origin discriminator above.

The table is FK-less because numbered migrations cannot depend on lazy Mastra
parents. `THREAD_DELETE_SIDECAR_TABLES` removes thread rows; the reset registry
owns all three table-enumerating reset paths. The shipped
`token-spend-by-tool` lens aggregates calls, characters, truncation, zero-match,
and the deliberate follow-up/first-page proxy without storing a search-session
correlation key.

