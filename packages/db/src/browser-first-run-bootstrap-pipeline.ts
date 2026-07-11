import type { PGlite } from '@electric-sql/pglite';
import { migrate } from './migrations/bootstrap.js';

/**
 * The dump/load pipeline at the heart of the first-run fast bootstrap (see
 * browser-first-run-bootstrap.ts for the full design):
 *
 *   memory PGlite → initdb + all migrations → dumpDataDir('none')
 *     → STRICT PGlite on the real `idb://` store via loadDataDir
 *     → one explicit awaited `syncToFs()` (the durable flush) → close.
 *
 * Pure orchestration over injected PGlite constructors so the SAME code runs
 * in production (inside the dedicated bootstrap worker, with real PGlite +
 * engine extensions) and in the real-engine integration tests (direct PGlite
 * instances on the test thread).
 *
 * Deliberately NOT built on PGliteWorker sessions: its leader-election
 * machinery rejects in-flight RPCs with 'Leader changed, pending operation in
 * indeterminate state' when the (asynchronously delivered) leader-here/
 * leader-now events land after the client has started issuing RPCs — a race
 * that ephemeral sole-member groups hit readily under load (observed live in
 * dev). A plain worker with direct PGlite instances has no election and no
 * RPC layer, and the dump never crosses a thread boundary.
 */

/** Minimal PGlite surface the pipeline needs. */
export interface FirstRunBootstrapDb {
  close(): Promise<void>;
  dumpDataDir(compression: 'auto' | 'gzip' | 'none'): Promise<Blob | File>;
  syncToFs(): Promise<void>;
}

export interface FirstRunBootstrapPipelineDeps {
  /** Throwaway in-memory database that receives initdb + all migrations. */
  createMemoryDb(): Promise<FirstRunBootstrapDb>;
  /**
   * STRICT (`relaxedDurability: false`) instance that creates the real store
   * from the migrated dump via PGlite's `loadDataDir`.
   */
  createStoreLoadDb(dataDir: string, dump: Blob | File): Promise<FirstRunBootstrapDb>;
  /**
   * Runs the full migration suite against the memory database. Defaults to
   * the production migration bootstrap; injectable for tests.
   */
  migrateDatabase?: (db: FirstRunBootstrapDb) => Promise<void>;
  /** Non-fatal close-failure reporting (a failed close must not fail the run). */
  onCloseError?: (stage: 'memory' | 'store-load', error: unknown) => void;
}

async function defaultMigrateDatabase(db: FirstRunBootstrapDb): Promise<void> {
  // Both the worker's real PGlite and test instances satisfy the query
  // surface runMigrations exercises; the nominal type bridge mirrors
  // db-provider's scheduledDb handling.
  await migrate(db as unknown as PGlite);
}

async function closeQuietly(
  db: FirstRunBootstrapDb,
  stage: 'memory' | 'store-load',
  onCloseError: FirstRunBootstrapPipelineDeps['onCloseError']
): Promise<void> {
  try {
    await db.close();
  } catch (error) {
    onCloseError?.(stage, error);
  }
}

/**
 * Runs the full dump/load bootstrap for `dataDir`. Resolves only after the
 * strict flush has completed; rejects on any failure (never a silent
 * fallback — the caller surfaces the error and the marker-based recovery
 * reclaims the partial store on the next launch).
 */
export async function runFirstRunBootstrapPipeline(
  dataDir: string,
  deps: FirstRunBootstrapPipelineDeps
): Promise<void> {
  const migrateDatabase = deps.migrateDatabase ?? defaultMigrateDatabase;

  let dump: Blob | File;
  const memoryDb = await deps.createMemoryDb();
  try {
    await migrateDatabase(memoryDb);
    // 'none': the tarball lives only in worker memory for seconds; skipping
    // gzip is faster on both ends and the loader consumes it immediately.
    dump = await memoryDb.dumpDataDir('none');
  } finally {
    await closeQuietly(memoryDb, 'memory', deps.onCloseError);
  }

  const storeDb = await deps.createStoreLoadDb(dataDir, dump);
  try {
    // The instance is strict, so this awaits the full Emscripten IDBFS flush
    // (one atomic readwrite transaction; the callback fires on
    // transaction.oncomplete) — once it resolves, the entire migrated data
    // dir is durable in IndexedDB.
    await storeDb.syncToFs();
  } finally {
    await closeQuietly(storeDb, 'store-load', deps.onCloseError);
  }
}
