/**
 * The single source of truth for the factory-reset/clear table union (BST-992).
 *
 * Before this module, three SQL reset paths each hand-enumerated their own
 * table list — desktop `db:clearAll` (`apps/desktop/src/ipc-domains/db-ipc.ts`),
 * renderer `clearViaPGlite`, and renderer `purgeTablesTx` (both in
 * `./db-provider.tsx`) — and they drifted: web's two lists silently omitted
 * four FK-less assistant tables that desktop cleared, so token/cost history,
 * task lists, edit-checkpoint before-content, and branch topology survived a
 * web factory reset (the BST-862/BST-844 defect class).
 *
 * The union CANNOT be derived from the Drizzle schema: the 21 `pgTable`
 * exports cover only ~9 of the 35 clearable relations. Every `brainstrike_*`
 * assistant table is migration-only raw DDL, the Mastra six live in
 * `@brainstrike/assistant-contract/mastra-memory-schema`, and configuration
 * tables that MUST survive reset (catalog, profile singletons) sit in the same
 * schema as tables that must not. So the source of truth is this curated
 * registry, and `reset-table-coverage.integration.test.ts` closes the drift
 * class from the other side: it sweeps `information_schema.tables` on a fully
 * migrated database and fails unless every existing table is either in the
 * registry or in `RESET_EXCLUDED_TABLES` with a written reason. A migration
 * that adds a table without a clear-or-exclude decision goes red.
 *
 * The three call sites keep their own ORDER and mechanics (children before
 * parents differs per path; desktop counts + bare-DELETEs `file_chunks` and
 * `file_records`). What this module owns is the SET, the closed union type the
 * probe helpers accept, and the exclusion ledger.
 */
import {
  MASTRA_BACKGROUND_TASKS_TABLE,
  MASTRA_MEMORY_TABLES,
  MASTRA_VECTOR_TABLE,
  MASTRA_WORKFLOW_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';

/**
 * The Mastra six. `typeof` expressions are TYPE-position reads, erased at
 * compile time, so they cannot participate in the module-scope chunk-init
 * hazard that `scripts/verify-mastra-schema-init-order.mjs` guards; the VALUES
 * are read only inside `getMastraResetTables()` below.
 */
export type MastraResetTable =
  | (typeof MASTRA_MEMORY_TABLES)[keyof typeof MASTRA_MEMORY_TABLES]
  | typeof MASTRA_BACKGROUND_TASKS_TABLE
  | typeof MASTRA_VECTOR_TABLE
  | typeof MASTRA_WORKFLOW_TABLE;

/**
 * Brainstrike-owned assistant persistence created by numbered migrations, not
 * the Drizzle schema. These include FK-less ledgers and relational graphs;
 * each is cleared explicitly by every table-enumerating reset path (FACTORY
 * RESET CONTRACT, docs/agents/platform-contracts.md).
 */
const BRAINSTRIKE_RESET_TABLES = [
  // Delegation ancestry is user data. Its self-FKs cascade the graph.
  'brainstrike_delegation_step_reservations',
  'brainstrike_delegation_child_budgets',
  'brainstrike_delegation_budgets',
  'brainstrike_delegated_tool_decisions',
  'brainstrike_delegated_invocations',
  'brainstrike_delegated_conversations',
  // Durable conversation-compaction ranges (migration 088, BST-1200). Exact
  // message-id sets cannot outlive the conversation rows they summarize.
  'brainstrike_assistant_compaction_ranges',
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_parents',
  // Soft-rewind tombstones (migration 080, BST-1115). Hidden-message
  // bookkeeping over conversation content the clear just destroyed: keeping it
  // would hide messages that no longer exist on the fresh database.
  'brainstrike_assistant_message_tombstones',
  // Request-build overlays for superseded native-tool projections (migration
  // 084, BST-1192). They refer only to thread/message evidence cleared here.
  'brainstrike_assistant_tool_projection_rewrites',
  'brainstrike_assistant_run_errors',
  'brainstrike_assistant_run_outcomes',
  // Per-run experiment treatment records (migration 093 + assistant-data
  // bootstrap mirror, BST-1250). Treatment evidence survives thread deletion
  // like run_outcomes, but never a true fresh start.
  'brainstrike_assistant_run_treatments',
  'brainstrike_assistant_run_usage',
  'brainstrike_assistant_task_lists',
  'brainstrike_assistant_thread_groups',
  'brainstrike_assistant_thread_placements',
  'brainstrike_assistant_thread_workspaces',
  'brainstrike_assistant_tool_output_artifacts',
  // Versioned Canvas documents (migration 082, BST-1173). Their thread-owned
  // content must not survive the conversation and resource identities a reset
  // just destroyed.
  'brainstrike_canvas_versions',
  // Durable counts/sizes-only per-tool telemetry (migration 083, BST-1190).
  // Baselines must survive restart, but never a true fresh start.
  'brainstrike_tool_call_telemetry',
  // Durable estimator/provider token-count pairs (migration 086, BST-1205).
  // Calibration evidence survives restart, but never a true fresh start.
  'brainstrike_token_estimate_calibration',
  'brainstrike_diagnostic_events',
  // Forge PR cache (migration 110, BST-1391). FK-less, main-written, and it
  // names remote repositories and branch topology — a "true fresh start" must
  // not carry it forward. It rebuilds from `gh` on the next observation.
  'brainstrike_forge_prs',
  // Sync-the-mind op-log seam (migration 079, BST-993). Clearing the mind
  // clears its op-log: pre-sync there is no peer the ops could replay to,
  // and a reset that kept tombstones for data it just destroyed would carry
  // "deletes" of rows that never existed on the fresh database.
  'brainstrike_mind_ops',
  // Principal-bound MCP Tasks handles and durable authority epochs (migration 114, BST-1562).
  // Handles precede their authority parent so table-enumerating resets respect the FK.
  'brainstrike_mcp_tasks',
  'brainstrike_mcp_task_authorities',
  'brainstrike_thread_message_index',
  'brainstrike_thread_search_state',
  // Shadow-git snapshot ledger (migration 081, BST-1164). Turn↔commit-oid
  // bookkeeping for threads the clear just destroyed: keeping it would map
  // conversations that no longer exist onto shadow commits. The shadow git
  // dirs themselves live under desktop userData (wiped wholesale by desktop
  // factory reset) and are unreachable from web, where these rows would
  // otherwise dangle forever.
  'brainstrike_workspace_snapshots',
  // Managed-worktree ledger (migration 109, BST-1390). The ROWS are cleared;
  // the worktree DIRECTORIES on disk are a separate, explicitly-confirmed step
  // in factory reset (see platform-contracts.md) — a reset must never silently
  // delete a folder full of the user's uncommitted work.
  'brainstrike_worktrees',
] as const;

/** Indexing/workspace data owned by the Drizzle schema. */
const CORE_RESET_TABLES = [
  'collection_indexing_stats',
  'embedding_sets',
  'file_chunks',
  'file_records',
  'job_queue',
  'prompt_items',
  'roots',
  'selection_snapshot_files',
  'selection_snapshots',
] as const;

/**
 * Wiped ONLY by the web factory reset (`purgeTablesTx`), never by Clear
 * Database (BST-992 convergence, executed 2026-07-31 under standing
 * approval): desktop factory reset destroys the whole profile directory, so
 * these previously survived a web factory reset while dying on desktop. All
 * six are seed-free caches/bookkeeping that rebuild on demand. Clear
 * Database keeps them on BOTH surfaces (desktop `db:clearAll` never cleared
 * them either — clear-set parity with {@link getResetTables} is untouched).
 *
 * `view_filter_presets` is deliberately NOT here despite being in the
 * original status-quo family: it is migration-SEEDED configuration
 * (custom-027 seeds the default presets), and the web purge preserves the
 * migrated schema without re-running migrations — wiping it would lose the
 * seeds forever on web, while desktop's rebuild-from-scratch restores them.
 */
const FACTORY_RESET_ONLY_TABLES = [
  'embedding_cache',
  'embedding_dimension_index_maintenance',
  'embedding_dimension_index_suspensions',
  'file_token_cache',
  'job_queue_metrics',
  'token_cache',
] as const;

export type FactoryResetOnlyTable = (typeof FACTORY_RESET_ONLY_TABLES)[number];

/**
 * Every relation a table-enumerating clear/reset path must empty. All three
 * paths clear this exact SET; only order and mechanics differ per path. The
 * probe helpers take this closed literal union — NEVER `string` — because with
 * `to_regclass` a stale name is indistinguishable from an absent relation and
 * becomes a permanent silent skip.
 */
export type ResetTable =
  | (typeof BRAINSTRIKE_RESET_TABLES)[number]
  | (typeof CORE_RESET_TABLES)[number]
  | MastraResetTable;

/**
 * The Mastra six as VALUES. Built inside a function — never a module-scope
 * const — because module-scope initializers run at bundle chunk
 * initialization, where the contract chunk is not guaranteed to have evaluated
 * (`scripts/verify-mastra-schema-init-order.mjs`, BST-558/#1988).
 *
 * Four of the six are migration-backed since BST-1651 (migration 117). Only
 * `mastra_vectors` and `mastra_workflow_snapshot` are still created lazily, by
 * Mastra's vector store and workflow storage respectively — see
 * {@link getLazyMastraResetTables}.
 */
export function getMastraResetTables(): readonly MastraResetTable[] {
  return [
    MASTRA_BACKGROUND_TASKS_TABLE,
    MASTRA_MEMORY_TABLES.messages,
    MASTRA_MEMORY_TABLES.observationalMemory,
    MASTRA_MEMORY_TABLES.resources,
    MASTRA_MEMORY_TABLES.threads,
    MASTRA_VECTOR_TABLE,
    MASTRA_WORKFLOW_TABLE,
  ];
}

/**
 * The Mastra relations that a fully migrated database still does NOT contain,
 * because nothing but Mastra's own vector store and workflow storage creates
 * them. The reset-coverage sweep uses this to tell a legitimately-absent
 * relation from a registry name that has rotted.
 */
export function getLazyMastraResetTables(): readonly MastraResetTable[] {
  return [MASTRA_VECTOR_TABLE, MASTRA_WORKFLOW_TABLE];
}

/** The full 41-relation reset set (26 Brainstrike + 9 core + the Mastra six). */
export function getResetTables(): readonly ResetTable[] {
  return [...BRAINSTRIKE_RESET_TABLES, ...CORE_RESET_TABLES, ...getMastraResetTables()];
}

/** The six web-factory-reset-only relations (seed-free caches/bookkeeping). */
export function getFactoryResetOnlyTables(): readonly FactoryResetOnlyTable[] {
  return FACTORY_RESET_ONLY_TABLES;
}

/** Everything the web factory reset empties: the clear set plus the six. */
export function getFactoryResetTables(): readonly (FactoryResetOnlyTable | ResetTable)[] {
  return [...getResetTables(), ...FACTORY_RESET_ONLY_TABLES];
}

/**
 * Tables that EXIST in a migrated database but are deliberately NOT in the
 * reset set, each with the reason it survives. The coverage integration test
 * requires every existing table to appear in exactly one of the two ledgers,
 * so removing a table from the reset set without writing its reason here goes
 * red — and a stale name here is self-healing in the safe direction: if the
 * excluded table is ever renamed, the real table becomes unregistered and the
 * sweep fails, forcing a fresh decision.
 */
export const RESET_EXCLUDED_TABLES = {
  // Keys are alphabetical (biome-sorted); each reason is self-contained. The
  // reasons fall into four families: migration LEDGERS, CONFIGURATION that
  // must survive a reset, CASCADE-covered children (deleting the registered
  // parent empties them), and "status quo" entries — tables no SQL path clears
  // on ANY surface today. Desktop factory reset destroys the status-quo group
  // with the profile directory while web factory reset leaves them; converging
  // web to full-wipe semantics is a behavior change awaiting a ruling
  // (BST-992), so those entries record the status quo as a DECISION rather
  // than an omission.
  __drizzle_migrations:
    'the sole production migration ledger (drizzle.config.ts) — clearing it would re-run every migration',
  _migrations:
    'schema-validation-only ledger (db-migration-authority); never production, never cleared',
  brainstrike_assistant_run_events:
    'migration 118; FK ON DELETE CASCADE from brainstrike_assistant_thread_runs AND mastra_threads',
  brainstrike_assistant_thread_runs: 'migration 118; FK ON DELETE CASCADE from mastra_threads',
  brainstrike_thread_search_profiles:
    'singleton search profile — configuration, intentionally survives (platform-contracts)',
  file_relationships: 'FK ON DELETE CASCADE from file_records (migration 003)',
  file_symbol_refs: 'FK ON DELETE CASCADE via file_symbols/file_records (migration 075)',
  file_symbols: 'FK ON DELETE CASCADE from file_records (migration 075)',
  file_tags: 'FK ON DELETE CASCADE from file_records (migration 003)',
  models: 'migration-seeded model catalog — configuration, re-seeding is migration work',
  prompt_embedding_profiles:
    'system embedding profile seeded by migration 051 — configuration, intentionally survives',
  prompt_item_revisions: 'FK ON DELETE CASCADE from prompt_items (migration 051)',
  providers: 'migration-seeded provider catalog — configuration, re-seeding is migration work',
  view_filter_presets:
    'MIXED table: migration-SEEDED defaults (is_default TRUE, custom-027) plus user-authored presets. Web factory reset issues a TARGETED DELETE of the user rows only (purgeTablesTx) — the purge cannot re-run migrations, so a full clear would lose the seeds forever, while desktop rebuild-from-scratch restores them. Excluded here because it is never FULLY cleared by any SQL path (BST-992 convergence, review #2162)',
} as const satisfies Record<string, string>;

export interface ResetTableCoverageAudit {
  /**
   * Names in more than one of the three ledgers (reset / factory-reset-only
   * / excluded) — the ledgers must stay pairwise disjoint. Deduplicated.
   */
  readonly doubleRegistered: readonly string[];
  /** Existing tables in NEITHER ledger — the BST-862/BST-844 drift signal. */
  readonly unregistered: readonly string[];
}

/**
 * Pure audit over a swept table list, so tests can control-test the instrument
 * with fabricated inputs (an audit that cannot fail is not evidence). The
 * `ledgers` parameter exists for exactly that reason: `doubleRegistered` is a
 * function of the two module constants, so without injection no fabricated
 * input could ever make it non-empty while the real ledgers are disjoint —
 * that half of the instrument would be unevidenced (review #2155). Production
 * call sites omit `ledgers`. `existingTables` should be every BASE TABLE in
 * the `public` schema of a fully migrated database.
 */
export function auditResetTableCoverage(
  existingTables: readonly string[],
  ledgers: {
    excluded?: readonly string[];
    factoryResetOnly?: readonly string[];
    reset?: readonly string[];
  } = {}
): ResetTableCoverageAudit {
  const resetSet = new Set<string>(ledgers.reset ?? getResetTables());
  const factoryOnly = new Set<string>(ledgers.factoryResetOnly ?? getFactoryResetOnlyTables());
  const excluded = new Set<string>(ledgers.excluded ?? Object.keys(RESET_EXCLUDED_TABLES));
  const unregistered = existingTables.filter(
    (name) => !(resetSet.has(name) || factoryOnly.has(name) || excluded.has(name))
  );
  const doubleRegistered = [
    ...new Set([
      ...[...resetSet].filter((name) => excluded.has(name) || factoryOnly.has(name)),
      ...[...factoryOnly].filter((name) => excluded.has(name)),
    ]),
  ];
  return { doubleRegistered, unregistered };
}
