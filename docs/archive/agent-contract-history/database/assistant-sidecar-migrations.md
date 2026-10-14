# Assistant sidecar migrations, migration by migration — evidence

Supports `docs/agents/database.md` § "ASSISTANT THREAD GROUP PRESENTATION".

The per-migration record for the assistant presentation and sidecar tables (056, 059, 067, 068, 076, 082, 083, 084, 086-092, 095, 110, 114, 115, 129) as it stood before distillation. Read when debugging one of these tables or extending its shape.

The record below is the original contract text, extracted unchanged.

Thread group structure and presentation are local-first Brainstrike state in
`brainstrike_assistant_thread_groups`, not Mastra thread metadata. Migration 056
owns group color and split flat/grouped rank; migration 059 owns the nullable,
validated group icon. The repository must reject unsupported color/icon values
at both read and write boundaries, and every new presentation column must be
added to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.

Migration 067 owns the thread hybrid-search index
(`brainstrike_thread_message_index` + `_search_profiles` + `_search_state`)
under the same Mastra-ownership ruling — no FKs to the Mastra tables, joined
by id, factory-reset-cleared except the singleton profile. Full contract:
`docs/agents/assistant-persistence.md` § THREADS PANEL HYBRID SEARCH.

Migration 068 owns complete tool-output artifact storage
(`brainstrike_assistant_tool_output_artifacts`). Content is exact UTF-8 in
`BYTEA`; callers pass hex text through PostgreSQL `decode` because
worker/Electron boundaries do not preserve a single JavaScript typed-array
realm. The table has no Mastra FKs, is scoped by resource/thread/run/tool call,
with migration 129 adding the native `execution_thread_id` to call uniqueness.
Existing rows retain their root thread as execution identity, preserving exact
replay, artifact IDs, bytes and expiry. Root resource/thread remain read authority;
execution identity cannot grant access. Conflicting bytes within one execution
still fail. Rollback refuses to discard persisted child execution identity.
The table
expires after seven days, and is explicitly factory-reset-cleared. Add
every change to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Keep the migration/repository/reset
tests paired with the persistence contract in
`docs/agents/assistant-persistence.md`.

Migration 114 owns the original generation-bound MCP Tasks handles in
`brainstrike_mcp_tasks`. Migration 115 upgrades that schema in place: it
backfills one authority epoch per historical generation, retires every older
generation in a scope, and makes only the highest generation live in
`brainstrike_mcp_task_authorities`.
The task identity is configured server, canonical resource, auth principal,
durable authority epoch, and task id. An authority epoch survives a Desktop
process restart even though the new host connection generation starts at one;
an increasing generation inside one runtime retires that epoch and mints a new
uuidv7 epoch, while a lower same-runtime generation is rejected as stale. Every
create/update SQL statement requires the exact live epoch/runtime/generation
lease, so retirement or factory-reset deletion fences late writes. Reset clears
task rows before their authority parent in all three table-enumerating paths.

The repository bounds transition history at 32 entries and rejects hydration
when timestamps regress, a terminal status is followed by another entry, or the
final history status/timestamp disagrees with `status`/`updated_at`. Metadata
limits are measured through PostgreSQL's canonical `jsonb::text`
representation; an oversize failure includes that representation's SHA-256 so
the lifecycle can persist a bounded omission projection without retaining the
payload. It lists resumable rows only for one exact live authority epoch.
Migration 115 also adds the bounded blocked diagnostic and is registered after
114 in `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Both tables are factory-reset
owned; never edit migration 114 to introduce the authority schema because an
existing BST-1562 profile must traverse the same upgrade.

A poller that abandons a task after bounded-lifetime or observation-failure
exhaustion rejects its caller but does not write a blocked diagnostic, so the
row keeps `terminal_at NULL` and `listActive` returns it to the next
`recover()`; only the oversize-state path persists the terminal blocked
diagnostic (BST-1581 verifier scope).

Migration 076 owns terminal provider-forensics storage
(`brainstrike_assistant_run_errors`) and the hot diagnostic correlation index
`bst_diagnostic_events_run_idx`. Add it to `migrations/index.ts` with a `ledgerKey`; the
Drizzle ledger is derived. The renderer schema probe includes the run-errors table;
migrations own its DDL. It retains its historical FK-less shape; migration 118 now owns
`brainstrike_assistant_thread_runs`. The canonical repository must derive
thread/resource ownership from that parent, throw when it is absent, and preserve the
first terminal row with `ON CONFLICT (run_id) DO NOTHING`. `cause_chain` is array-shaped
JSON, `response_headers` is object-shaped JSON, and there is deliberately no `attempts`
column until an honest complete retry producer exists. Pair every shape change with
migration and schema-probe tests, explicit thread-deletion cleanup, and all three
table-enumerating reset paths. Full contract: `docs/agents/assistant-persistence.md` §
RUN ERROR PROVIDER FORENSICS.

Migration 082 owns the FK-less `brainstrike_canvas_versions` ledger. Add it to
`migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Include it in
the renderer schema probe, and keep thread-delete plus factory-reset ownership explicit.
A Canvas document is the rows sharing one app-side uuidv7 `canvas_id`; greatest
`version` is current. Full contract: `docs/agents/assistant-persistence.md` § CANVAS
DOCUMENT VERSIONS.

Migration 086 owns the FK-less `brainstrike_token_estimate_calibration` ledger. Each row
stores a durable, model/provider-attributed run-end pair of `estimated_prompt_tokens`
and `final_step_prompt_tokens`; the desktop writer derives `thread_id` from the existing
`run_id` with `INSERT ... SELECT` rather than trusting a carried thread id. Rows contain
numbers, ids, model/provider strings, and timestamps only—never message content, tool
content, prompts, file paths, or command text. The migration is registered in
`migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. The table is
registered in the shared factory-reset registry and the thread-delete sidecar list. The
renderer schema probe includes it because the repository references every sidecar
unconditionally even though desktop main owns normal writes.

Scope is intentionally explicit. The numerator, `estimated_prompt_tokens`, is
`RunTokenDiagnostics`'s chars/4 backstop over model-visible tool-output
projections plus tool definitions, each counted once. The denominator,
`final_step_prompt_tokens`, is the single latest step's prompt count, which
already contains every prior tool output once via Mastra's resend behavior—not
the cross-step accumulated billing total. Both figures are comparable over the
same final-prompt-content basis; conversation/system-prompt text outside tool
outputs and definitions is excluded from both. Only completed runs with at
least one measured tool output persist a row.

Migration 089 adds nullable positive domain/transport resolved-budget token columns. New
calibration rows persist the concrete run tier; historical rows remain NULL because
backfilling an anchor would fabricate evidence. Migrations own both the fresh shape and
upgrade seam. The ordinal column order preserves migration 086's trailing `occurred_at`
before the two columns migration 089 appends. The estimator lens groups by model plus
both tier columns.

Migration 091 adds nullable positive `prompt_baseline_tokens`, the same run's
prompt-composition total of system instructions, task list, and tool definitions. The
next turn's pre-request compaction trigger reads the newest thread-scoped calibration
row because that baseline is not yet available when compaction runs. Historical rows
remain NULL rather than receiving fabricated prompt evidence. This is an additive
FK-less ledger extension registered in `migrations/index.ts` with a `ledgerKey`; the
Drizzle ledger is derived. The migration owns the fresh and upgrade shapes; the renderer
performs no DDL. It inherits the calibration table's existing 60-day retention and
`occurred_at`-leading maintenance path; no new retention logic or privacy surface is
introduced.

The least-new-mechanism seam is a standalone table modeled on migration 083.
Both figures already meet in the agent/main-process stream before the existing
desktop persistence wrapper. Extending
`brainstrike_assistant_run_usage` would require transporting the agent-only
diagnostic backstop into its renderer-side `handleUsage` writer, adding a new
process-boundary mechanism without improving attribution or fidelity.

Retention exactly mirrors tool-call telemetry: rows older than 60 days are pruned
unbounded on idle passes and oldest-first in bounded batches while the job queue is
active, with a cheap expired-row guard probe. Migration 086 ships the
`occurred_at`-leading index from the start plus a `thread_id` index for the
thread-delete sidecar predicate, and idle maintenance includes the table in `VACUUM
(ANALYZE)`. Factory reset clears the evidence while normal restarts retain it. Paired
tests cover agent emission/omission, desktop run/thread attribution in real PGlite,
migration/reset/schema-probe coverage, 60-day maintenance, and the checked-in
`estimator-calibration.sql` lens golden path through `parseLensFile`,
`coerceLensValues`, and `AgentSqlService.query`.

Migration 084 owns the FK-less `brainstrike_assistant_tool_projection_rewrites` overlay
used by BST-1192's transient stale-read replay processor. Add it to
`migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived. Register the
table in the reset registry, all three table-enumerating clear paths, and the shared
thread-delete sidecar list. Include it in the renderer schema probe because that
repository's delete CTE references every sidecar unconditionally even though desktop
main owns normal writes. Durable Mastra message content is never mutated. Migration 087
adds the supersession/prune discriminator and nullable superseder used by BST-1200's
recency pruning; the migration ledger carries the final shape. Supersession rewind
recovery remains the processor's current-prompt superseder-presence check, while prune
rows remain active whenever their own call is visible. Full contract:
`docs/agents/assistant-persistence.md` § STALE TOOL-PROJECTION REWRITE OVERLAYS.

Migration 088 owns the FK-less `brainstrike_assistant_compaction_ranges` overlay used by
BST-1200 Milestone 2's durable conversation summaries. Persist an exact ordered JSONB
set of compacted message IDs rather than interpreting opaque client/UUIDv4 message IDs
as sortable range keys. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle
ledger is derived. Register the table in the reset registry, all three table-enumerating
clear paths, and the shared thread-delete sidecar list. Include it in the renderer
schema probe for the same unconditional thread-delete-CTE reason as migration 084. The
overlay processor derives liveness from the summary message's presence in Mastra's
already-tombstone-filtered ID-bearing input-step message list; neither raw Mastra
content nor rewind state is mutated.

Migration 090 widens `brainstrike_assistant_run_usage.run_kind` to admit
`compaction-summary`, the provider-exact auxiliary summarizer call attributed under its
parent run. Add the constraint replacement to `migrations/index.ts` with a `ledgerKey`;
the Drizzle ledger is derived. The numbered migration replaces migration 077's existing
same-name CHECK using `DROP CONSTRAINT` + `ADD CONSTRAINT`; adding only the TypeScript
union makes real PGlite inserts fail. Renderer repositories only probe schema readiness
and never create or alter constraints.

Migration 095 owns the FK-less `brainstrike_assistant_thread_workspaces` sidecar
(BST-1268): one row per thread (`thread_id` PK) holding that thread's saved workspace as
a versioned JSONB `payload` (open app/file tabs, editor view state, per-root tree
expansions, root view). Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle
ledger is derived. Register the table in the shared factory-reset registry and the
thread-delete sidecar list, and include it in the renderer schema probe — the renderer
coordinator is the sole writer, and the thread-delete CTE references every registered
sidecar unconditionally. The payload is repaired section-wise on read by
`coerceWorkspaceSnapshot` (unknown versions fall back to the empty snapshot; expansion
lists are capped shallowest-first), so schema evolution happens in the payload version,
not in DDL churn. Rows contain workspace file paths and tab ids; message content,
prompts, and file contents are prohibited. Paired pins:
`packages/assistant-data/src/__tests__/thread-workspace-contract.test.ts`
(migration-owned CREATE TABLE shape, schema-probe and sidecar-list membership,
reset-registry membership) plus the pinned counts in
`packages/db/__tests__/reset-table-registry.test.tsx`.

Migration 110 owns the FK-less `brainstrike_forge_prs` cache (BST-1391): one
normalized GitHub pull-request observation per realpath'd git common directory
and branch. Add it to `migrations/index.ts` with a `ledgerKey`; the Drizzle ledger is derived.
Register the table in every table-enumerating factory-reset path. It is not a thread-delete sidecar because pull requests
outlive individual threads and are shared by threads on the same branch. The
thread-row PR pill reads it through ONE list-wide, unparameterized PGlite
live query (`use-forge-pr-cache.ts`) rather than a per-thread lookup, so it
renders instantly on boot and offline; the composer's live status instead
reads the capability-gated `window.forge` bridge, which is the only surface
that needs the transient in-flight/error state this table does not carry.

