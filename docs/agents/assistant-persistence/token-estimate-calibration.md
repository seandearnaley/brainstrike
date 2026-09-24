# Token-estimate calibration pairs — evidence

Supports `docs/agents/assistant-persistence.md` §
"TOKEN-ESTIMATE CALIBRATION PAIRS". Read this before proposing to change the stored columns, the ratio basis, retention, or the checked-in lens.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`brainstrike_token_estimate_calibration` (migration 086 plus additive migrations
089 and 091 in BOTH runners)
stores one attributable run-end pair: the chars/4 estimate measured by
`RunTokenDiagnostics` and `final_step_prompt_tokens`, the single most recent
step's prompt-token count. The internal `token-estimate-calibration` stream
chunk is consumed by the desktop main-process persistence wrapper and never
reaches the renderer. The writer uses `INSERT ... SELECT` through
`brainstrike_assistant_thread_runs` to derive `thread_id` from `run_id`, warns
without failing the assistant turn on a missing run or failed write, and stores
only ids, token counts, model/provider strings, and a timestamp. Migration 089
adds nullable positive `resolved_domain_budget_tokens` and
`resolved_transport_budget_tokens`: new runtime-produced samples populate both,
while historical rows remain NULL rather than receiving a guessed tier.
Migration 091 adds nullable positive `prompt_baseline_tokens`, the same run's
system-instructions + task-list + tool-definition total used by the next turn's
baseline-aware compaction trigger. Historical rows and continuation chunks
without a prompt breakdown remain NULL rather than receiving a guessed value.

The numerator is `modelVisibleProjectionBackstopTokens +
(toolDefinitionBackstopTokens ?? 0)`: chars/4 over model-visible tool-output
projections plus tool definitions, each counted once. The denominator is the
latest step's prompt count, which already contains every prior tool output once
via Mastra's resend behavior—not the cross-step accumulated billing total. Both
figures are comparable over the same final-prompt-content basis;
conversation/system-prompt text outside tool outputs and definitions is excluded
from both. Only completed runs with at least one measured tool output persist.
The ratio remains reconciliation evidence, not permission to tune
`APPROX_CHARS_PER_TOKEN`.

The table is FK-less because numbered migrations cannot depend on the lazy
assistant parents. The repository's thread-delete CTE references every sidecar
unconditionally, which is why the table is part of the schema PROBE (BST-1651);
`THREAD_DELETE_SIDECAR_TABLES` removes thread-owned rows, and the reset registry
owns all table-enumerating fresh-start paths. Scheduled database maintenance
prunes rows after 60 days on both idle and active-queue passes, using the
occurred-at-leading index created in migration 086; the idle pass also runs
`VACUUM (ANALYZE)` for the table.

The checked-in `estimator-calibration.sql` lens groups an inclusive time window
by model and both resolved budget-token columns, then returns sample count plus
min/median/max/average estimate-to-final-step ratios. NULL groups expose legacy
pre-089 samples honestly. It excludes zero estimates defensively and counts only positive
denominators, matching runs that actually exercised the estimator. Paired
proofs are the emission cases in `packages/agent/src/__tests__/mastra-streaming.spec.ts`,
the real-PGlite desktop persistence integration test, the migration/reset and
scheduled-maintenance tests in `packages/db/__tests__`, and
`search-lens-estimator-calibration.test.ts`, which parses and executes the
checked-in lens rather than an inlined copy.

