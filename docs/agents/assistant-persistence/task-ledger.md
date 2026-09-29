# Task ledger, verdicts and budget guardrails — evidence

Supports `docs/agents/assistant-persistence.md` §
"TASK LEDGER (RUN OUTCOMES + LEDGER READ MODEL)". Read this before proposing to change experiment treatments, outcome precedence, the ledger read model, or the budget guardrail.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Per-run cost/outcome analytics over tables the assistant already writes.

- **Experiment treatments (BST-1250, recursive self-improvement phase 2A):**
  `brainstrike_assistant_run_treatments` (migration 093, sole author since
  BST-1651 retired the bootstrap mirror; no FKs; retained on
  thread delete like run_outcomes, cleared on factory reset via the db reset
  registry; sole index is `(created_at)` — the lens's only predicate). One
  row per hosted run, `run_id` PK. Normal legs record DETACHED (`void`) from
  the injector seam (`self-improvement-signal-context.ts`) — the ONE place
  that knows whether BST-1241 injection actually happened and its exact text
  (`signal_content_hash` = SHA-256; null when nothing injected); the write
  never blocks prompt assembly, and the recorder logs its own failures.
  Approval/resume continuation legs mint their own runId but return BEFORE
  the injectors, so `stream-init` fires the optional
  `runPersistence.recordContinuationRunTreatment` capability for them —
  without it those legs carry outcome labels with no treatment row, a
  systematically biased gap. `injection_status`
  (`injected | preference_off | no_waste | query_failed | continuation`)
  keeps the non-injection reasons apart: an ENROLLED run whose signal query
  failed is NOT control evidence; `signal_injected` is derived and
  CHECK-pinned to `status = 'injected'`. `experiment_id`/`variant` come from
  the strictly-parsed renderer `experimentAssignment` (both fields required
  on the wire; malformed → warn + un-enrolled, never coerced) and stay NULL
  when un-enrolled. The renderer producer (BST-1251, phase 2B) is the
  experiment-assignment preference store + settings section; it attaches the
  pair only when both fields are set, so a half-filled preference stays
  un-enrolled instead of tripping the strict parse.
  `ON CONFLICT (run_id) DO NOTHING` — the first treatment wins. Do NOT infer
  treatment from date windows or the current preference value — this record
  exists because both are unsound. Queryable via the
  `experiment-outcome-correlation` lens (groups by injection_status; LEFT
  JOINs outcomes so unlabeled runs stay visible). Paired tests:
  `self-improvement-signal-context.test.ts` ("run treatment recording"),
  `run-treatment-persistence.integration.test.ts`,
  `search-lens-experiment-outcome-correlation.test.ts`.

- **Outcome labels:** `brainstrike_assistant_run_outcomes` (migration 062, sole
  author since BST-1651 retired the bootstrap mirror; no FKs, purged
  on factory reset via db-ipc `OptionalRelationTable`). At most ONE label per
  run (`verdict` succeeded/failed/mixed, upserted on run_id) with provenance
  `source` (`user` | `edit_revert` | `hook`) and bounded `detail` (2000 chars,
  oversized THROWS — never silently truncated). Writer: `recordRunOutcome`
  (app-shell repository). A later user verdict deliberately replaces a derived
  `edit_revert` or `hook` label. `edit_revert` labels are derived in
  `use-edit-checkpoints.ts` after a successful revert (see
  workspace-context.md § Edit Checkpoint Journal). `hook` labels come from the
  Stop-hook run-verdict protocol (a Stop hook prints one strict
  `{"brainstrikeRunVerdict":…}` JSON line; see assistant-runtime.md
  § TOOL-LIFECYCLE HOOKS), recorded MAIN-PROCESS-side by
  `recordDesktopAssistantHookRunOutcome` (apps/desktop assistant-server/run-persistence.ts) —
  an upsert byte-consistent with `recordRunOutcome` (documented duplication,
  same precedent as the bootstrap SQL) that derives thread/resource ids from
  the runs row and carries the SQL precedence guard `source <> 'user'`: a hook
  label never overwrites an explicit user verdict (both writers enforce it —
  the repository applies the same guard for `source: 'hook'`), while a later
  user verdict still upserts over a hook label. The write is awaited in front
  of the stream's `message-finish` yield so a finishing run cannot lose it to
  terminal bookkeeping.
- **User verdicts (👍/👎):** `RunVerdictControl` (packages/ui
  `run-verdict-control.tsx`) mounts on every assistant message and renders once
  per run — on the message leg carrying the terminal `run.finished` run-event
  data part (works for edit-less runs; `run.failed` legs are deliberately
  excluded in v1, and web local-runtime events without a runId are skipped).
  The capability seam is `RunVerdictProvider`/`useRunVerdictContext`
  (`run-verdict-context.tsx`) — PARALLEL to EditCheckpointContext by design:
  verdicts gate on the repository's optional `recordRunOutcome` (present
  wherever the PGlite repo exists, including web), not the desktop checkpoint
  bridge. App-shell binds it via `useRunVerdictBinding`
  (`hooks/use-run-verdict.ts`, source `'user'`, upserts over derived labels);
  a rejected save shows a visible retry, never a silent drop. Write-only in
  v1 (no read-back of a stored label after reload — the ledger remains the
  authoritative view). The wrapper line-budget bump and the panel
  owned-module assertions live in `assistant-contract-boundary.test.ts` and
  `assistant-ui-panel-architecture.test.ts`.
- **Ledger read model:** `getRunLedger(resourceId, {limitLatest})` aggregates
  each `thread_runs` row with SUM'd run_usage tokens + exact billed cost
  (absent — never a fabricated 0 — when unreported), top-level
  `tool.completed`/`tool.failed` counts (subagent.tool.* excluded in v1),
  edit-checkpoint totals + reverted counts, computed `durationMs`, and the
  outcome label. `RUN_LEDGER_AGGREGATION_SQL` + `mapRunLedgerRow` are the
  exported single source of truth (same convention as
  `CROSS_ROOT_USAGE_AGGREGATION_SQL`); the strict mapper THROWS on malformed
  aggregates. Both are optional on `AssistantThreadRepository` (read-only/test
  repositories) and required on `BulkAssistantThreadRepository`.

- **Ledger panel:** the Task Ledger renders inside the existing **Cost
  Tracking settings category** (`createCostTrackingSettingsCategory` in
  `packages/app-shell/src/cost-tracking/index.tsx`, consumed by both apps'
  settings page-content), stacked below `CostAggregationPanel`. Data is
  renderer-direct (Path A): `use-run-ledger.ts` is a PGlite live query over the
  shared `RUN_LEDGER_AGGREGATION_SQL` + `mapRunLedgerRow` pair (limit 50), and
  `use-ledger-analytics.ts` fetches `getLedgerCostTrend` (day bucket) +
  `getModelComparison` with a manual refresh. Both gate on
  `hasDurableAssistantUsageCapability()` exactly like the sibling cost panel
  (web renders an honest session-only state). Honest-cost rules: exact
  provider-reported cost renders as-is; a registry-priced remainder is marked
  "est."; unpriced models read "cost unavailable" and zero-usage runs read
  "no usage recorded" — NEVER a fabricated $0; malformed aggregates and query
  failures surface as a visible error state with retry, never an
  empty-but-fine panel.

- **Budget guardrails (v1):** user-set spend caps over the ledger's own data.
  State ownership: the caps (`dailyCapUsd`, `perRunCapUsd`, both null = off by
  default) are persisted in
  `packages/app-state/src/stores/assistant-budget-preferences-store.ts`
  (STRICT set validation — finite > 0 or null, else THROW; factory-reset via
  `resetAssistantBudgetPreferencesStoreToDefaults`), edited in the Cost
  Tracking settings category (`budget-settings-panel.tsx`, blank = off,
  invalid input shows a visible validation message — never coerced). Spend is
  derived, never stored: `DAILY_SPEND_AGGREGATION_SQL` (+ strict
  `mapDailySpendUsageRow` / pure `resolveDailySpendSummary` in
  `cost-tracking/daily-spend.ts`, live-queried by `use-daily-spend.ts` under
  the durable-usage capability gate) sums run_usage over a ROLLING
  `created_at >= NOW() - INTERVAL '24 hours'` window — deliberately
  timezone-free, so ALL UI copy says "last 24h", never "today"; it binds each
  SQL param exactly once (PGlite live format() constraint, see
  RUN_LEDGER_AGGREGATION_SQL). Honesty: exact billed cost + registry-priced
  remainder; unpriced-model tokens are EXCLUDED from the total and surfaced as
  an explicit "+N unpriced" marker — never a fabricated price. App-shell binds
  cap + spend (`hooks/use-budget-guardrail.ts`) into the packages/ui context
  seam (`budget-guardrail-context.tsx`, provider mounted in the wrapper beside
  RunVerdictProvider); the composer chip/notice/gate live in
  `budget-guardrail-control.tsx`. Over-cap rules — no silent block, no silent
  allow: while `overCap && !overridden`, BOTH send paths (composer input+Send,
  edit-composer resend) are disabled and a visible notice states "Last-24h
  budget cap reached — $X of $Y" with an explicit "Send anyway" session
  override; an active override is stated next to the chip; Stop/Cancel is
  never gated. If the spend query fails the guardrail deactivates (null
  binding) and the failure is logged as an error — v1 deliberately fails open
  because blocking on a broken analytics query would be a silent block with no
  honest number to show. `perRunCapUsd` is DISPLAY-ONLY: the ledger panel
  badges runs whose exact-or-priced cost exceeds it (`isRunOverCap`; unpriced
  or zero-usage runs are never flagged on a fabricated number).
- **Subagent budgets:** `packages/app-state/src/stores/assistant-subagent-preferences-store.ts`
  (strict set validation through `parseRuntimeSubagentSettings` — an invalid
  value THROWS and lands nothing; hydration sanitizes an invalid persisted
  payload to the defaults; factory reset via
  `resetAssistantSubagentPreferencesStoreToDefaults`), edited in Settings →
  Models → Subagents (`subagent-settings-section.tsx`, the parser's message is
  shown under the field — never coerced), sent on every request as
  `runtimeData.subagentSettings`; see docs/agents/assistant-subagents.md.

When changing this flow, update this section and the paired tests
(`packages/db/__tests__/migration-062-assistant-run-outcomes.test.ts`,
`packages/assistant-data/src/__tests__/run-ledger-row.test.ts`, the run-outcome and
run-ledger cases in `assistant-memory-repository.integration.test.ts`
(including the hook-over-user precedence case), the
outcome-labeling suite in `use-edit-checkpoints.test.ts`, the hook-verdict
suites in `apps/desktop/src/__tests__/assistant-server/`
(`hooks/run-verdict.test.ts`, the verdict cases in
`hooks/server-composition.integration.test.ts`,
`hook-run-outcome.integration.test.ts`), the panel suites
in `packages/app-shell/src/cost-tracking/__tests__/` — `task-ledger-panel`,
`use-run-ledger`, `use-ledger-analytics`, and the budget-guardrail suites:
`daily-spend` / `use-daily-spend` / `budget-settings-panel` there,
`use-budget-guardrail` + `daily-spend.integration` in
`packages/app-shell/src/__tests__/`, `budget-guardrail-control` in
`packages/ui/src/__tests__/`, and `assistant-budget-preferences-store` +
`factory-reset-assistant-budget-preferences` in
`packages/app-state/src/__tests__/`).

