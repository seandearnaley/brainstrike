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
 * exports cover only ~9 of the 27 clearable relations. Every `brainstrike_*`
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
  | typeof MASTRA_VECTOR_TABLE
  | typeof MASTRA_WORKFLOW_TABLE;

/**
 * Brainstrike-owned assistant persistence created by numbered migrations, not
 * the Drizzle schema. None of these has an FK that would cascade it — each one
 * must be cleared explicitly by every table-enumerating reset path (FACTORY
 * RESET CONTRACT, docs/agents/platform-contracts.md).
 */
const BRAINSTRIKE_RESET_TABLES = [
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_parents',
  'brainstrike_assistant_run_errors',
  'brainstrike_assistant_run_outcomes',
  'brainstrike_assistant_run_usage',
  'brainstrike_assistant_task_lists',
  'brainstrike_assistant_thread_groups',
  'brainstrike_assistant_thread_placements',
  'brainstrike_assistant_tool_output_artifacts',
  'brainstrike_diagnostic_events',
  'brainstrike_thread_message_index',
  'brainstrike_thread_search_state',
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
 */
export function getMastraResetTables(): readonly MastraResetTable[] {
  return [
    MASTRA_MEMORY_TABLES.messages,
    MASTRA_MEMORY_TABLES.observationalMemory,
    MASTRA_MEMORY_TABLES.resources,
    MASTRA_MEMORY_TABLES.threads,
    MASTRA_VECTOR_TABLE,
    MASTRA_WORKFLOW_TABLE,
  ];
}

/** The full 27-relation reset set (12 brainstrike + 9 core + the Mastra six). */
export function getResetTables(): readonly ResetTable[] {
  return [...BRAINSTRIKE_RESET_TABLES, ...CORE_RESET_TABLES, ...getMastraResetTables()];
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
    'bootstrap-only DDL (assistant-memory-repository); FK ON DELETE CASCADE from brainstrike_assistant_thread_runs AND mastra_threads',
  brainstrike_assistant_thread_runs:
    'bootstrap-only DDL (assistant-memory-repository); FK ON DELETE CASCADE from mastra_threads',
  brainstrike_thread_search_profiles:
    'singleton search profile — configuration, intentionally survives (platform-contracts)',
  embedding_cache:
    'status quo: content-hash-keyed cache, not cleared by any SQL path; web-reset convergence pending ruling (BST-992)',
  embedding_dimension_index_maintenance:
    'status quo: HNSW maintenance bookkeeping, not cleared by any SQL path (BST-992)',
  embedding_dimension_index_suspensions:
    'status quo: HNSW suspension bookkeeping, not cleared by any SQL path (BST-992)',
  file_relationships: 'FK ON DELETE CASCADE from file_records (migration 003)',
  file_symbol_refs: 'FK ON DELETE CASCADE via file_symbols/file_records (migration 075)',
  file_symbols: 'FK ON DELETE CASCADE from file_records (migration 075)',
  file_tags: 'FK ON DELETE CASCADE from file_records (migration 003)',
  file_token_cache:
    'status quo: token-count cache, rebuilt on demand, not cleared by any SQL path (BST-992)',
  job_queue_metrics:
    'status quo: queue outcome metrics (migration 049), not cleared by any SQL path (BST-992)',
  models: 'migration-seeded model catalog — configuration, re-seeding is migration work',
  prompt_embedding_profiles:
    'system embedding profile seeded by migration 051 — configuration, intentionally survives',
  prompt_item_revisions: 'FK ON DELETE CASCADE from prompt_items (migration 051)',
  providers: 'migration-seeded provider catalog — configuration, re-seeding is migration work',
  token_cache:
    'status quo: token-count cache, rebuilt on demand, not cleared by any SQL path (BST-992)',
  view_filter_presets:
    'status quo: user view presets, not cleared by any SQL path; web-reset convergence pending ruling (BST-992)',
} as const satisfies Record<string, string>;

export interface ResetTableCoverageAudit {
  /** Names in BOTH ledgers — a contradiction that must be resolved. */
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
  ledgers: { excluded?: readonly string[]; reset?: readonly string[] } = {}
): ResetTableCoverageAudit {
  const resetSet = new Set<string>(ledgers.reset ?? getResetTables());
  const excluded = new Set<string>(ledgers.excluded ?? Object.keys(RESET_EXCLUDED_TABLES));
  const unregistered = existingTables.filter((name) => !(resetSet.has(name) || excluded.has(name)));
  const doubleRegistered = [...resetSet].filter((name) => excluded.has(name));
  return { doubleRegistered, unregistered };
}
