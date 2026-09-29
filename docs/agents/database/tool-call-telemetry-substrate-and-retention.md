# Tool-call telemetry: substrate split and 60-day retention — evidence

Supports `docs/agents/database.md` § "ASSISTANT THREAD GROUP PRESENTATION".

Migration 092's substrate split (why the pre-split OR fold blamed the model for the BST-1246 ripgrep degradation) and the BST-1198 retention design, including migration 085's dedicated `occurred_at` index and the active-queue guard probe. Read before changing telemetry columns or retention.

The record below is the original contract text, extracted unchanged.

Migration 083 owns the FK-less `brainstrike_tool_call_telemetry` ledger for durable
model-facing per-tool counts and sizes. Add it to `migrations/index.ts` with a
`ledgerKey`; the Drizzle ledger is derived. Register the table in the
reset/thread-delete registries. Include it in the renderer schema probe: although only
the migrated desktop main-process assistant server writes rows, the renderer
repository's thread-delete CTE references every registered sidecar unconditionally. Rows
contain only thread/ run/tool ids, timestamps, numeric sizes, and booleans; raw tool
inputs and outputs are prohibited. Migration 074's default-privilege grant makes the
later-created table readable by the `brainstrike.querySelf` sandbox role. The primary
key uses `crypto.randomUUID()` (matching the sibling `brainstrike_assistant_run_usage`
writer), not a uuidv7 — this table is a net-new counters ledger outside any sync-related
rework, so AGENTS.md's uuidv7-groundwork carve-out does not apply.

**Substrate split (migration 092, BST-1247):** `truncated` means exactly
"model-facing output was clipped". Substrate degradation lives in its own
columns — `engine` (live-pass engine for search tools: 'ripgrep' | 'js-walk'
| 'skipped'; NULL for non-search tools and all pre-092 rows), `scan_limited`,
and `candidates_truncated` — populated by the desktop writer from flags the
search results already carry. The pre-split OR fold made the
`self-improvement-signal` waste ranking blame the model for the BST-1246
ripgrep degradation (94-100% "truncation" that was mostly the capped JS-walk
fallback). Pre-092 rows are acknowledged-ambiguous: their `truncated` keeps
the old folded meaning, is NOT backfilled, and ages out of the lens's 24h
window; `engine IS NULL` marks them. The lens excludes degraded calls from
`truncation_hit_rate`/`zero_match_rate` and reports
`substrate_degraded_rate` separately
(`packages/db/__tests__/search-lens-self-improvement-signal.test.ts` pins
this).

**Retention (BST-1198, closes the BST-1190 deferral):** rows older than 60
days are pruned by the existing scheduled-database-maintenance mechanism —
`runScheduledDatabaseMaintenance` in
`packages/db/src/services/scheduled-database-maintenance.ts`, the same
idle-triggered pass that runs the #1716 plain `ANALYZE` sweep for
`file_records`/`embedding_cache`, the `VACUUM (ANALYZE)` sweep that includes
`file_chunks`, and the terminal-job prune. No
new scheduler or timer was added, but retention did require one small
migration:
- `DEFAULT_DATABASE_MAINTENANCE_TOOL_CALL_TELEMETRY_RETENTION_MS` (60 days) is
  the default; callers may override it via
  `ScheduledDatabaseMaintenanceOptions.toolCallTelemetryRetentionMs`, resolved
  and validated (non-negative) on every pass, like the sibling job-queue
  options.
- Migration 083's `brainstrike_tool_call_telemetry_tool_time_idx` is
  `(tool_id, occurred_at DESC)` — `tool_id`-leading, so it cannot serve a bare
  `occurred_at` range predicate as an index scan; both retention deletes
  filter on `occurred_at` alone. **Migration 085** (version 84 is skipped —
  claimed by the still-open BST-1192 PR #2333) adds a dedicated
  `brainstrike_tool_call_telemetry_occurred_at_idx` on `occurred_at` so the
  guard probe and both deletes below are real index scans, not sequential
  scans of the whole table. Registered in `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Migrations alone create the index;
  the renderer probes the table as described for migration 083.
- Idle passes (`status: 'completed'`) run a full, unbounded-by-count
  age-DELETE — the same shape as `pruneTerminalJobs`.
- Passes while the job queue is active (`status: 'partial'`) first run a
  cheap `SELECT EXISTS (...)` guard probe on `occurred_at` (an index scan that
  stops at the first match); only when it finds an expired row does an
  `activePruneLimit`-bounded age-DELETE run, `ORDER BY occurred_at ASC` so an
  over-limit backlog evicts oldest-first — the same oldest-first shape as
  `DiagnosticEventsRepository.purge()`. The guard exists because the common
  case on a ~10-minute tick is that nothing is expired yet, and without it
  every tick would still pay for planning/running the bounded DELETE for zero
  deletions. This still bounds telemetry growth while a long-running backfill
  keeps the job queue busy, for the same reason job rows once needed it.
- `brainstrike_tool_call_telemetry` is in
  `DEFAULT_DATABASE_MAINTENANCE_VACUUM_TABLES` alongside `job_queue`, so the
  idle path's `VACUUM (ANALYZE)` actually reclaims the dead tuples the idle
  DELETE creates (PGlite has no autovacuum launcher — without this the table's
  heap/index disk usage would keep growing at the same rate, just as dead
  pages instead of live rows) and gives the `token-spend-by-tool` lens planner
  fresh column statistics it previously never got. Only the active-queue path
  defers `VACUUM` until idle; the idle path now genuinely runs it for both
  tables.
- The result's `prunedToolCallTelemetryRows` field reports the count for both
  branches; the desktop scheduler logs it alongside `prunedTerminalJobs`.
Paired tests: `packages/db/__tests__/scheduled-database-maintenance.test.ts`
(`tool_call_telemetry retention (BST-1198)` describe block) proves old rows
are pruned and newer rows survive on both the idle and active-queue paths,
that the active-queue guard probe skips the DELETE when nothing is expired,
that an over-limit active-queue backlog evicts oldest-first, that
`brainstrike_tool_call_telemetry` is VACUUMed on the idle path, and that the
`token-spend-by-tool` lens output for an in-window query is unaffected by
pruning outside that window. Migration coverage:
`packages/db/__tests__/migration-085-tool-call-telemetry-occurred-at-index.test.ts`
(index created on both runners; a forced-seqscan-off `EXPLAIN` probe proves
the bare `occurred_at` predicate resolves to an index scan on it).
