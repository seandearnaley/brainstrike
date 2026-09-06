/**
 * The renderer-owned PGlite transport: direct in-process PGlite for tests and
 * non-browser utilities, and the worker-hosted browser client for `idb://` /
 * `opfs-ahp://` stores (`wasm-loader.createPGliteClient` picks). It is the ONE
 * transport that owns a closable database, so every BST-1329 close hazard
 * lives here: the first-run bootstrap window, the connection registered before
 * `migrate()` finishes, and the purge that must run on the RAW connection
 * (never the scheduled handle) so it cannot deadlock on its own reset barrier.
 *
 * `isAvailable()` is unconditionally true: this is the terminal transport, the
 * one every surface can always fall back to opening. Selection order in
 * `db-provider.tsx` puts the capability-probed desktop bridge ahead of it.
 */
import {
  MASTRA_MEMORY_TABLES,
  MASTRA_VECTOR_TABLE,
  MASTRA_WORKFLOW_TABLE,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { createLogger } from '@brainstrike/logging';
import type { PGlite } from '@electric-sql/pglite';
import { maybeBootstrapBrowserFirstRunStore } from './browser-first-run-bootstrap.js';
import {
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
} from './browser-pglite-storage.js';
import type {
  ClearAllDataResult,
  DatabaseTransport,
  DatabaseTransportClearContext,
  DatabaseTransportOpenContext,
  DbConnectionSnapshot,
} from './database-runtime.js';
import {
  createScheduledDbHandle,
  type DatabaseWorkPriority,
  type ScheduledDbHandle,
} from './database-work-scheduler.js';
import { createDbHandle, type QueryExecutor } from './db-handle.js';
import { drizzle } from './drizzle/database.js';
import { migrate, PGVECTOR_EXTENSION_PRESENCE_QUERY } from './migrations/bootstrap.js';
import { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import type { FactoryResetOnlyTable, ResetTable } from './reset-table-registry.js';
import {
  type PGliteRuntimeClient,
  runFirstRunBootstrapInWorker,
  wasmLoader,
} from './wasm-loader.js';

/** Shared with the runtime on purpose — see the note in `database-runtime.ts`. */
const logger = createLogger('DbProvider');

/**
 * Every relation the clear/reset paths empty. A closed union rather than a
 * `string` parameter ON PURPOSE: because the helper below PROBES with
 * `to_regclass`, a stale or misspelled name is indistinguishable from an absent
 * table and becomes a PERMANENT SILENT SKIP — no error, no warn, only a
 * `logger.debug`, with every test still green.
 *
 * Derived from the reset-table registry (BST-992) rather than hand-enumerated:
 * the registry owns the SET all three table-enumerating reset paths clear;
 * this file owns the renderer paths' order and mechanics.
 * `reset-table-registry.test.ts` asserts each renderer path clears exactly the
 * registry set, so a table added to the registry without a call site here (or
 * vice versa) fails fast.
 */
type ClearableRelation = FactoryResetOnlyTable | ResetTable;

/**
 * Deletes every row of a relation that may legitimately be ABSENT, PROBING for
 * it first rather than deleting and catching "relation does not exist".
 *
 * Both reset paths run their whole body inside ONE transaction, and PGlite is
 * real Postgres: a statement error puts the transaction into the ABORTED state,
 * after which every later command fails with `25P02 current transaction is
 * aborted, commands ignored until end of transaction block` until ROLLBACK.
 * Catching the 42P01 does not undo that and there are no savepoints anywhere in
 * this repo, so catch-and-tolerate could never actually tolerate anything — it
 * rolled the ENTIRE reset back. `to_regclass` returns NULL for an absent
 * relation instead of raising, so the probe can never poison the transaction
 * (BST-558 review).
 *
 * This replaces five overlapping predecessors, including the bare
 * `catch (err) { logger.warn(...) }` blocks in `clearViaPGlite`. Those swallowed
 * EVERY error, not just a missing relation: the first genuine failure aborted
 * the transaction, each following `25P02` was swallowed in turn, and the caller
 * was eventually told the transaction was aborted rather than which statement
 * actually failed. Measured, not reasoned — an FK violation on `roots` produced
 * three consecutive "(table may not exist)" warnings before surfacing as a
 * misleading 25P02.
 *
 * The DELETE after a successful probe is deliberately NOT wrapped: nothing in
 * this repo ever DROPs these relations, so the probe/delete race is unreachable,
 * and a tolerated error there could not recover anyway. A genuine delete failure
 * must surface as itself.
 *
 * Callers pass `MASTRA_WORKFLOW_TABLE` itself, never a hand-copied literal: with
 * `to_regclass` a stale name returns NULL forever, turning the clear into a
 * permanent silent skip rather than a visible error. That constant is read only
 * INSIDE functions — never into a module-scope const — because module-scope
 * initializers run at bundle chunk initialization, where the contract chunk is
 * not guaranteed to have evaluated; the binding would be `undefined` and
 * `to_regclass('undefined')` returns NULL. Enforced repo-wide by
 * `scripts/verify-mastra-schema-init-order.mjs` (BST-558, #1988).
 */
async function clearRelationIfPresent(
  tx: { query: (sql: string) => Promise<unknown> },
  table: ClearableRelation
): Promise<void> {
  const probe = (await tx.query(`SELECT to_regclass('${table}') IS NOT NULL AS present`)) as
    | { rows?: Array<{ present?: boolean }> }
    | undefined;
  if (probe?.rows?.[0]?.present !== true) {
    // `debug`, not `warn`: an absent relation is the expected state for a
    // never-used assistant or a pre-migration database, and warn+ records are
    // persisted into brainstrike_diagnostic_events — one of the tables this
    // clear is emptying.
    logger.debug(`[DbProvider] Skipped absent ${table} table during clear`);
    return;
  }
  await tx.query(`DELETE FROM ${table}`);
}

async function closeDirectConnection(db: PGliteRuntimeClient, dataDir: string): Promise<void> {
  try {
    if (isBrowserPersistentPGliteDataDir(dataDir)) {
      await wasmLoader.closeCached(dataDir);
    } else {
      await db.close();
    }
  } catch (err: unknown) {
    const errorMessage = (err as Error)?.message || '';
    if (!(errorMessage.includes('closed') || errorMessage.includes('PGlite is closed'))) {
      logger.error('Failed to close database:', err);
    }
  }
}

async function purgeAndCloseDirectDb(
  db: PGliteRuntimeClient,
  dataDir: string,
  purgeTablesTx: (tx: { query: (sql: string) => Promise<unknown> }) => Promise<void>
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await purgeTablesTx(tx);
    });
  } catch (error) {
    logger.error('[DbProvider] Failed to purge tables during factory reset:', error);
    throw error;
  }
  try {
    await db.exec('VACUUM');
  } catch (err) {
    logger.warn('VACUUM after purge failed:', err);
  }
  if (isBrowserPersistentPGliteDataDir(dataDir)) {
    try {
      await wasmLoader.closeCached(dataDir);
      logger.info('[DbProvider] Closed cached browser PGlite instance during factory reset');
    } catch (err) {
      logger.warn('Failed to close cached browser PGlite instance during reset:', err);
    }
  } else {
    try {
      await db.close();
    } catch (err) {
      logger.warn('Closing database after purge failed:', err);
    }
  }
}

async function loadDrizzleEmbeddingSetsRepository() {
  const mod = await import('./repositories/drizzle/embedding-sets-repository.js');
  return mod.DrizzleEmbeddingSetsRepository;
}

async function loadDrizzleViewFilterPresetsRepository() {
  const mod = await import('./repositories/drizzle/view-filter-presets-repository.js');
  return mod.DrizzleViewFilterPresetsRepository;
}

function getRendererDefaultDatabaseWorkPriority(): DatabaseWorkPriority {
  if (typeof window === 'undefined') {
    return 'foreground';
  }
  const search = window.location?.search ?? '';
  const mode = new URLSearchParams(search).get('mode');
  return mode === 'embedding-host' || mode === 'chunking-host' ? 'background' : 'foreground';
}

/**
 * The factory-reset purge: every relation in the reset registry PLUS the six
 * seed-free factory-reset-only relations (BST-992 convergence). Runs inside
 * ONE transaction on the RAW connection.
 */
async function purgeTablesTx(tx: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  // Sequential by necessity — see the identical note in clearViaPGlite: one
  // connection, one transaction, so `Promise.all` would race statements and
  // turn any single failure into a pile of `25P02`s.
  await clearRelationIfPresent(tx, 'prompt_items');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_output_artifacts');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_run_errors');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_placements');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_workspaces');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_groups');
  await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.messages);
  await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.observationalMemory);
  await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.threads);
  await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.resources);
  await clearRelationIfPresent(tx, MASTRA_VECTOR_TABLE);
  await clearRelationIfPresent(tx, MASTRA_WORKFLOW_TABLE);
  // Task Ledger outcome labels: web-writable (user verdicts), no FK —
  // clear explicitly per the FACTORY RESET CONTRACT (review #1693).
  await clearRelationIfPresent(tx, 'brainstrike_assistant_run_outcomes');
  // Per-run experiment treatment records (migration 093, BST-1250).
  await clearRelationIfPresent(tx, 'brainstrike_assistant_run_treatments');
  // BST-992 drift fix: FK-less desktop-parity stores web previously missed —
  // token/cost history, task lists, edit-checkpoint before-content, and
  // branch topology must not survive a web factory reset.
  await clearRelationIfPresent(tx, 'brainstrike_assistant_run_usage');
  // Forge PR cache (migration 110, BST-1391): FK-less, must not survive a
  // web factory reset.
  await clearRelationIfPresent(tx, 'brainstrike_forge_prs');
  // Managed-worktree ledger (migration 109). Rows only — directories on
  // disk are handled by the explicit factory-reset step.
  await clearRelationIfPresent(tx, 'brainstrike_worktrees');
  await clearRelationIfPresent(tx, 'brainstrike_mcp_tasks');
  await clearRelationIfPresent(tx, 'brainstrike_mcp_task_authorities');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_task_lists');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_edit_checkpoints');
  await clearRelationIfPresent(tx, 'brainstrike_assistant_message_parents');
  // Soft-rewind tombstones (migration 080, BST-1115).
  await clearRelationIfPresent(tx, 'brainstrike_assistant_message_tombstones');
  // Shadow-git snapshot ledger (migration 081, BST-1164).
  await clearRelationIfPresent(tx, 'brainstrike_workspace_snapshots');
  // Versioned Canvas documents (migration 082, BST-1173).
  await clearRelationIfPresent(tx, 'brainstrike_canvas_versions');
  // Durable per-tool model-facing telemetry (migration 083).
  await clearRelationIfPresent(tx, 'brainstrike_tool_call_telemetry');
  // Estimator/provider prompt-token calibration pairs (migration 086).
  await clearRelationIfPresent(tx, 'brainstrike_token_estimate_calibration');
  // Superseded native-tool projection overlays (migration 084).
  await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_projection_rewrites');
  // Durable conversation-compaction ranges (migration 088).
  await clearRelationIfPresent(tx, 'brainstrike_assistant_compaction_ranges');
  await clearRelationIfPresent(tx, 'brainstrike_thread_message_index');
  await clearRelationIfPresent(tx, 'brainstrike_thread_search_state');
  await clearRelationIfPresent(tx, 'brainstrike_diagnostic_events');
  // Mind op-log (migration 079): cleared with the mind it describes (BST-993).
  await clearRelationIfPresent(tx, 'brainstrike_mind_ops');
  await clearRelationIfPresent(tx, 'job_queue');
  await clearRelationIfPresent(tx, 'collection_indexing_stats');
  await clearRelationIfPresent(tx, 'embedding_sets');
  await clearRelationIfPresent(tx, 'selection_snapshot_files');
  await clearRelationIfPresent(tx, 'selection_snapshots');
  await clearRelationIfPresent(tx, 'file_chunks');
  await clearRelationIfPresent(tx, 'file_records');
  // After file_records (the FK child): stale roots would otherwise survive a
  // reset and resurface as ghost workspaces once consumers read the table.
  await clearRelationIfPresent(tx, 'roots');
  // FACTORY-RESET-ONLY convergence (BST-992): desktop factory reset
  // destroys the profile directory, so these six seed-free caches and
  // bookkeeping tables previously survived only on web. Clear Database
  // intentionally keeps them on both surfaces; view_filter_presets stays
  // out (migration-seeded — the purge preserves schema without re-running
  // migrations, so its seeds would be lost forever).
  await clearRelationIfPresent(tx, 'token_cache');
  await clearRelationIfPresent(tx, 'file_token_cache');
  await clearRelationIfPresent(tx, 'embedding_cache');
  await clearRelationIfPresent(tx, 'job_queue_metrics');
  await clearRelationIfPresent(tx, 'embedding_dimension_index_suspensions');
  await clearRelationIfPresent(tx, 'embedding_dimension_index_maintenance');
  // view_filter_presets mixes migration-SEEDED defaults (is_default TRUE,
  // custom-027) with USER-authored presets (is_default FALSE). Desktop
  // factory reset destroys both and re-seeds; the web purge cannot re-run
  // migrations, so it deletes ONLY the user rows — seeds survive, user
  // presets converge with desktop (review #2162). Targeted delete, not the
  // probe helper: the predicate makes it a partial clear, and the table is
  // migration-guaranteed so a probe adds nothing.
  await tx.query('DELETE FROM view_filter_presets WHERE is_default = FALSE');
}

async function purgeQueuesAndSetsTx(tx: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  try {
    await tx.query('DELETE FROM job_queue');
  } catch (err) {
    logger.warn('Failed to clear job_queue (transaction):', err);
  }
  try {
    await tx.query('DELETE FROM collection_indexing_stats');
  } catch (err) {
    logger.warn('Failed to clear collection_indexing_stats (transaction):', err);
  }
  try {
    await tx.query('DELETE FROM embedding_sets');
  } catch (err) {
    logger.warn('Failed to clear embedding_sets (transaction):', err);
  }
}

export interface PgliteDirectTransportOptions {
  /**
   * The resolved data dir. Read through a thunk, not captured, so it always
   * reflects the current provider props (the old `resolvedPath` closure).
   */
  readonly getDataDir: () => string;
}

interface DirectConnection {
  readonly dataDir: string;
  readonly db: PGliteRuntimeClient;
}

export function createPgliteDirectTransport(
  options: PgliteDirectTransportOptions
): DatabaseTransport {
  let connection: DirectConnection | null = null;

  const open = async (
    context: DatabaseTransportOpenContext
  ): Promise<DbConnectionSnapshot | null> => {
    const resolvedPath = options.getDataDir();
    logger.debug('Using direct PGlite connection');

    // First-run fast bootstrap: a not-yet-existing browser idb:// store is
    // created greenfield from an in-memory migrated dump (strict flush)
    // instead of paying strict per-statement durability through initdb +
    // every migration (~53s → a few seconds). Existing stores skip in one
    // cheap probe; failures propagate to the visible init error state.
    if (isIndexedDbPGliteDataDir(resolvedPath) && typeof Worker !== 'undefined') {
      const bootstrapResult = await maybeBootstrapBrowserFirstRunStore(resolvedPath, {
        bootstrapStore: (dataDir) => runFirstRunBootstrapInWorker(dataDir),
        // 'resolve' on BLOCKED (another tab still holds the torn store): the
        // delete settles reporting `blocked: true` and the recovery path
        // throws its loud "close other tabs" error directly — instead of
        // hanging DB init on the factory-reset default of waiting for the
        // holding connection to close.
        deleteStore: (dataDir) =>
          wasmLoader.deleteIndexedDB(dataDir, { blockedBehavior: 'resolve' }),
      });
      logger.info('First-run PGlite bootstrap check', { ...bootstrapResult, resolvedPath });
    }

    const db = await wasmLoader.createPGliteClient(resolvedPath);
    if (context.isDisposed()) {
      // BST-1329: the runtime was disposed while this client was being built,
      // so the teardown saw no connection at all and closed
      // nothing. Nothing has issued a statement against this instance yet —
      // no drain is owed — but it must not be installed or leaked (an
      // abandoned `idb://` client holds its IndexedDB lock and the next open
      // fails with the "close other tabs" recovery error).
      logger.debug('[DbProvider] Closing PGlite client created after unmount');
      await closeDirectConnection(db, resolvedPath);
      return null;
    }
    connection = { dataDir: resolvedPath, db };

    const scheduledDb = createScheduledDbHandle(
      db as unknown as QueryExecutor & object,
      context.scheduler,
      getRendererDefaultDatabaseWorkPriority()
    ) as unknown as PGlite & ScheduledDbHandle;

    await migrate(scheduledDb);

    // Check if pgvector extension is available
    let hasVector = false;
    try {
      const result = await scheduledDb.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
      hasVector = result.rows.length > 0;
      logger.debug('pgvector extension detected', { available: hasVector });
    } catch (err) {
      logger.debug('Could not detect pgvector extension:', err);
    }
    if (!hasVector) {
      throw new Error(
        'pgvector extension failed to initialize. Ensure @electric-sql/pglite-pgvector is bundled.'
      );
    }

    // Create Drizzle instance and type-safe repositories
    // Dynamic imports via module-level helpers (avoids import() in component scope);
    // the two repository modules are independent, so load them concurrently.
    const [DrizzleEmbeddingSetsRepo, DrizzleViewFilterPresetsRepo] = await Promise.all([
      loadDrizzleEmbeddingSetsRepository(),
      loadDrizzleViewFilterPresetsRepository(),
    ]);
    const drizzleInstance = drizzle(scheduledDb);
    const repository = new DrizzleFileRecordRepository(drizzleInstance);
    const chunkRepo = new DrizzleFileChunkRepository(drizzleInstance);
    const embeddingSetsRepo = new DrizzleEmbeddingSetsRepo(drizzleInstance);
    const viewFilterPresetsRepo = new DrizzleViewFilterPresetsRepo(drizzleInstance);
    return {
      chunkRepository: chunkRepo,
      drizzleDb: drizzleInstance,
      embeddingSetsRepository: embeddingSetsRepo,
      exposedDb: createDbHandle(scheduledDb as unknown as QueryExecutor),
      fileRecordRepository: repository,
      vectorEnabled: hasVector,
      viewFilterPresetsRepository: viewFilterPresetsRepo,
    };
  };

  const clearAllData = async (
    context: DatabaseTransportClearContext
  ): Promise<ClearAllDataResult> => {
    if (!connection) {
      await context.ensureInitialized();
    }
    const conn = connection;
    if (!conn) {
      throw new Error(
        'Direct PGlite database not available (IPC connections use clearViaElectronIPC)'
      );
    }

    return await conn.db.transaction(async (tx) => {
      // Clear chunks first due to foreign key constraints
      const chunksResult = await tx.query('SELECT COUNT(*) as count FROM file_chunks');
      const chunksRow = chunksResult.rows[0] as { count: string | number } | undefined;
      const deletedChunks = chunksRow?.count || 0;
      await tx.query('DELETE FROM file_chunks');

      await clearRelationIfPresent(tx, 'selection_snapshot_files');
      await clearRelationIfPresent(tx, 'selection_snapshots');

      // Then clear files
      const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
      const filesRow = filesResult.rows[0] as { count: string | number } | undefined;
      const deletedFiles = filesRow?.count || 0;
      await tx.query('DELETE FROM file_records');

      // These awaits are deliberately SEQUENTIAL, not `Promise.all` (react-doctor
      // async-parallel flags them): they are statements on ONE PGlite connection
      // inside ONE transaction. Interleaving them races statements on a single
      // connection, and once any statement fails the transaction is aborted, so
      // the rest would only pile up `25P02` errors.
      //
      // After file_records (the FK child): stale roots would otherwise survive a
      // clear and resurface as ghost workspaces once consumers read the table.
      await clearRelationIfPresent(tx, 'roots');
      // Also clear embedding sets and queue to avoid stale state.
      await clearRelationIfPresent(tx, 'collection_indexing_stats');
      await clearRelationIfPresent(tx, 'embedding_sets');
      await clearRelationIfPresent(tx, 'job_queue');
      // Revisions cascade from prompt_items. The system embedding profile is
      // configuration seeded by migration 051 and intentionally survives.
      await clearRelationIfPresent(tx, 'prompt_items');
      // Durable per-thread token/cost usage (migration 046): FK-less, so
      // nothing cascades it — cost history must not survive a fresh start.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_usage');
      // FK-less terminal provider forensics can contain response metadata and
      // error text. Clear them before the lazy parent run/thread stores.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_errors');
      // Task Ledger outcome labels (migration 062): writable on web via the
      // renderer repository (user verdicts), no FK cascades them — clear
      // explicitly per the FACTORY RESET CONTRACT (review #1693).
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_outcomes');
      // Per-run experiment treatment records (migration 093, BST-1250):
      // FK-less experiment evidence must not survive a fresh start.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_run_treatments');
      // BST-992 drift fix: desktop `db:clearAll` cleared these three FK-less
      // stores but web missed them, so the assistant task list, edit-checkpoint
      // before-content, and assistant-ui branch topology survived a web clear.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_task_lists');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_edit_checkpoints');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_message_parents');
      // Soft-rewind tombstones (migration 080, BST-1115): bookkeeping over
      // conversation content this clear destroys, so it goes with it.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_message_tombstones');
      // Shadow-git snapshot ledger (migration 081, BST-1164): turn↔commit-oid
      // bookkeeping for threads this clear destroys, so it goes with them.
      await clearRelationIfPresent(tx, 'brainstrike_workspace_snapshots');
      // Versioned Canvas documents (migration 082, BST-1173): thread-owned
      // content must not survive the threads/resources this clear destroys.
      await clearRelationIfPresent(tx, 'brainstrike_canvas_versions');
      // Durable per-tool model-facing telemetry (migration 083): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_tool_call_telemetry');
      // Estimator/provider prompt-token calibration pairs (migration 086): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_token_estimate_calibration');
      // Superseded native-tool projection overlays (migration 084): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_projection_rewrites');
      // Durable conversation-compaction ranges (migration 088): FK-less.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_compaction_ranges');
      // Complete tool output can contain sensitive command results and has no FK
      // to Mastra-owned message tables, so it must be deleted explicitly.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_tool_output_artifacts');
      // Thread grouping is Brainstrike-owned assistant presentation state.
      // Delete placements before groups, and both before Mastra threads.
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_placements');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_workspaces');
      await clearRelationIfPresent(tx, 'brainstrike_assistant_thread_groups');
      // Mastra memory tables are lazy, database-owned assistant persistence.
      // Delete children before their logical parents even though the current
      // schema does not declare foreign keys. Vectors are deliberately cleared
      // without an index-name filter: every assistant-memory index belongs to
      // the database being reset (BST-844).
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.messages);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.observationalMemory);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.threads);
      await clearRelationIfPresent(tx, MASTRA_MEMORY_TABLES.resources);
      await clearRelationIfPresent(tx, MASTRA_VECTOR_TABLE);
      // Suspended Mastra workflow snapshots: unbounded lifetime, no FK, and they
      // retain the pending tool call and its arguments (BST-558).
      await clearRelationIfPresent(tx, MASTRA_WORKFLOW_TABLE);
      // Thread search index (migration 067): derived conversation text + sync
      // state. Diagnostic events (migration 073): the durable warn+ error log,
      // no FK, so nothing cascades it. Neither may survive a "true fresh start"
      // per the FACTORY RESET CONTRACT. The singleton search profile is
      // configuration and intentionally survives, like the prompt profile.
      await clearRelationIfPresent(tx, 'brainstrike_thread_message_index');
      await clearRelationIfPresent(tx, 'brainstrike_thread_search_state');
      await clearRelationIfPresent(tx, 'brainstrike_diagnostic_events');
      // Forge PR cache (migration 110, BST-1391): FK-less remote-branch
      // topology, rebuilt on the next `gh` observation.
      await clearRelationIfPresent(tx, 'brainstrike_forge_prs');
      // Managed-worktree ledger (migration 109). Rows only — directories on
      // disk are handled by the explicit factory-reset step.
      await clearRelationIfPresent(tx, 'brainstrike_worktrees');
      await clearRelationIfPresent(tx, 'brainstrike_mcp_tasks');
      await clearRelationIfPresent(tx, 'brainstrike_mcp_task_authorities');
      // Mind op-log (migration 079): tombstones for data this reset just
      // destroyed must not survive onto the fresh database (BST-993).
      await clearRelationIfPresent(tx, 'brainstrike_mind_ops');

      return { deletedChunks: Number(deletedChunks), deletedFiles: Number(deletedFiles) };
    });
  };

  const cleanupAfterReset = async (): Promise<void> => {
    const resolvedPath = options.getDataDir();
    // Delete the IndexedDB database to fully wipe corrupted TOAST chunks
    if (resolvedPath.startsWith('idb://')) {
      try {
        await wasmLoader.deleteIndexedDB(resolvedPath);
        logger.info('[DbProvider] IndexedDB deleted successfully');
        // Wait for IndexedDB deletion to fully complete
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      } catch (err) {
        logger.warn('[DbProvider] Failed to delete IndexedDB, reinitializing anyway:', err);
      }
    } else {
      // Even for non-IDB paths, wait a bit to ensure cleanup completes
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  };

  return {
    cleanupAfterReset,
    clearAllData,
    clearQueuesAndEmbeddingSets: async () => {
      const conn = connection;
      if (!conn) {
        return;
      }
      await conn.db.transaction(async (tx) => {
        await purgeQueuesAndSetsTx(tx);
      });
    },
    detachConnection: () => {
      const conn = connection;
      connection = null;
      if (!conn) {
        return null;
      }
      const { db, dataDir } = conn;
      return async () => {
        await closeDirectConnection(db, dataDir);
      };
    },
    // A renderer-owned PGlite has no out-of-band reset: the runtime's
    // barrier -> drain -> purge -> close sequence IS its factory reset.
    hardReset: () => Promise.resolve(false),
    hasOpenConnection: () => connection !== null,
    isAvailable: () => true,
    kind: 'pglite-direct',
    open,
    purgeAndClose: async () => {
      const conn = connection;
      if (!conn) {
        return;
      }
      await purgeAndCloseDirectDb(conn.db, conn.dataDir, purgeTablesTx);
      connection = null;
    },
  };
}
