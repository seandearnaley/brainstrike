/**
 * The desktop database transport: every statement crosses the preload bridge
 * to the main process, which owns the filesystem-backed PGlite and is the
 * single arbiter of its work queue. The renderer therefore owns NOTHING
 * closable here — `detachConnection()` returns `null`, and factory reset is
 * delegated wholesale to `db.resetLocal()` (which deletes the profile
 * directory), so the renderer's drain/purge/close sequence never runs.
 *
 * Availability is a CAPABILITY probe — "does `window.electronAPI?.db` exist" —
 * never an `isElectron()` check (AGENTS.md).
 */
import { createLogger } from '@brainstrike/logging';
import type { DatabaseDiagnosticsSnapshot, DatabaseInitAttemptRecord } from '@brainstrike/types';
import type {
  ClearAllDataResult,
  DatabaseTransport,
  DbConnectionSnapshot,
} from './database-runtime.js';
import { createDbHandle, type QueryExecutor } from './db-handle.js';
import { type DesktopDatabaseBridge, getDesktopDatabaseBridge } from './desktop-database-bridge.js';
import { PGVECTOR_EXTENSION_PRESENCE_QUERY } from './migrations/bootstrap.js';
import { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';

/** Shared with the runtime on purpose — see the note in `database-runtime.ts`. */
const logger = createLogger('DbProvider');

// Module-level dynamic import helpers — extracted from component scope
// so the React Compiler's HIR builder doesn't encounter import() expressions.
async function loadElectronEmbeddingSetsRepository() {
  const mod = await import('./repositories/electron-embedding-sets-repository.js');
  return mod.ElectronEmbeddingSetsRepository;
}

async function loadElectronViewFilterPresetsRepository() {
  const mod = await import('./repositories/electron-view-filter-presets-repository.js');
  return mod.ElectronViewFilterPresetsRepository;
}

const INIT_STOP_ACTIVITY = {
  'index-rebuild': 'rebuilding the search index',
  migration: 'applying database migrations',
  'open-database': 'opening the database and replaying its log',
} as const;

/** Main's own words for a stop; the same copy the manager's `DbHostInitStoppedError` carries. */
function formatInitStop(stop: DatabaseInitAttemptRecord): string {
  const activity = stop.report
    ? INIT_STOP_ACTIVITY[stop.report.phase]
    : 'starting the database process';
  const times =
    stop.consecutiveTimeouts === 2 ? 'twice' : `${stop.consecutiveTimeouts} times in a row`;
  const budget =
    stop.budgetMs < 1000 ? `${stop.budgetMs} ms` : `${Math.round(stop.budgetMs / 1000)} s`;
  return `BrainStrike stopped retrying the database start: ${activity} timed out ${times} (last budget ${budget}). Nothing was deleted or replaced.`;
}

function formatDesktopDatabaseInitError(
  diagnostics: DatabaseDiagnosticsSnapshot | null,
  fallbackMessage: string
): string {
  // First: while main is stopped it answers from its own record and forks no host, so the snapshot
  // carries no failure and every branch below would blame the wrong thing.
  if (diagnostics?.initStop) {
    return formatInitStop(diagnostics.initStop);
  }
  const failure = diagnostics?.lastInitializationFailure;
  const rawFailureMessage =
    failure && typeof failure === 'object' && 'message' in failure
      ? (failure as { message?: unknown }).message
      : null;
  const failureMessage = normalizeFailureMessage(rawFailureMessage);
  const failureDetail = failureMessage ? ` Last failure: ${failureMessage}` : '';

  if (!failure) {
    return `pgvector extension is required for desktop. Ensure @electric-sql/pglite-pgvector is available.${failureDetail}`;
  }

  if (failure.category === 'concurrency') {
    return `Desktop database is already in use by another BrainStrike process. Close other instances and restart.${failureDetail}`;
  }

  if (failure.category === 'corruption') {
    return `Desktop database reported an integrity error and could not be opened. BrainStrike did not delete or replace it.${failureDetail}`;
  }

  if (failure.category === 'wasm-runtime') {
    return `Desktop database runtime aborted while opening the database.${failureDetail}`;
  }

  if (failure.category === 'filesystem') {
    return `Desktop database filesystem access failed.${failureDetail}`;
  }

  if (failure.category === 'migration') {
    return `Desktop database migration failed.${failureDetail}`;
  }

  if (failure.category === 'missing-extension') {
    return `pgvector extension is required for desktop. Ensure @electric-sql/pglite-pgvector is available.${failureDetail}`;
  }

  return `${fallbackMessage}${failureDetail}`;
}

const NORMALIZE_FAILURE_MESSAGE_MAX_DEPTH = 5;

function normalizeFailureMessage(message: unknown, depth = 0): string | null {
  if (depth >= NORMALIZE_FAILURE_MESSAGE_MAX_DEPTH) {
    return null;
  }

  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (!trimmed.length) {
      return null;
    }
    if (trimmed === '[object Object]') {
      return null;
    }
    return trimmed;
  }

  if (message && typeof message === 'object') {
    if ('message' in message) {
      const nestedMessage = (message as { message?: unknown }).message;
      const normalizedNestedMessage = normalizeFailureMessage(nestedMessage, depth + 1);
      if (normalizedNestedMessage) {
        return normalizedNestedMessage;
      }
    }
    try {
      const serialized = JSON.stringify(message);
      if (serialized && serialized !== '{}') {
        return serialized;
      }
    } catch {
      return String(message);
    }
  }

  if (message === null || message === undefined) {
    return null;
  }

  return String(message);
}

async function getElectronDiagnostics(
  electronDB: DesktopDatabaseBridge
): Promise<DatabaseDiagnosticsSnapshot | null> {
  if (!electronDB.diagnostics) {
    return null;
  }
  try {
    return await electronDB.diagnostics();
  } catch (error) {
    logger.warn('Failed to fetch desktop database diagnostics', { error });
    return null;
  }
}

async function testElectronConnection(electronDB: DesktopDatabaseBridge): Promise<void> {
  if (!electronDB.test) {
    return;
  }

  try {
    const testResult = await electronDB.test();
    if (!testResult.success) {
      throw new Error(`Database test failed: ${testResult.message}`);
    }
    logger.debug('Database test passed', { message: testResult.message });
  } catch (error) {
    logger.warn('Database test not available or failed:', error);
  }
}

export interface ElectronIpcTransportOptions {
  /**
   * The `useElectronIPC` opt-in. A thunk so the transport never holds a value it
   * cannot re-read, but the provider builds it in a lazy `useState` initializer,
   * so it closes over the props of the FIRST render — the mount-time contract
   * `DbProvider` documents. It does not track later prop changes, and must not:
   * re-opening a transport would swap the database out from under live
   * repositories.
   */
  readonly isEnabled: () => boolean;
}

export function createElectronIpcTransport(
  options: ElectronIpcTransportOptions
): DatabaseTransport {
  /** The bridge this transport published; the main process owns the database. */
  let bridge: DesktopDatabaseBridge | null = null;

  const isAvailable = (): boolean => Boolean(options.isEnabled() && getDesktopDatabaseBridge());

  const open = async (): Promise<DbConnectionSnapshot | null> => {
    const electronDB = getDesktopDatabaseBridge();
    if (!electronDB) {
      // Selection already probed this. A bridge that vanished in between is a
      // broken capability, not a reason to quietly open a second database.
      throw new Error('Electron database bridge disappeared before initialization');
    }

    logger.debug('Using Electron IPC database connection');

    await testElectronConnection(electronDB);
    const electronExec = electronDB.exec;

    if (!electronExec) {
      throw new Error('Electron database exec operation is unavailable over IPC');
    }

    const repositoryDb = {
      exec: async (sql: string) => {
        await electronExec(sql);
      },
      query: electronDB.query,
      // Atomic transaction primitive (#1141): lets repositories run tuning + SELECT
      // in ONE main-process pglite.transaction() so a concurrent FTS query can't
      // interleave. Search rejects explicitly if the preload lacks this capability.
      ...(electronDB.runTransaction ? { transaction: electronDB.runTransaction } : {}),
    };

    // The repository doesn't need the test method, so we can pass just the db interface
    const repository = new ElectronFileRecordRepository(repositoryDb);
    // Detect pgvector extension availability over IPC
    let hasVector = false;
    let diagnostics: DatabaseDiagnosticsSnapshot | null = null;
    try {
      const res = await electronDB.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
      hasVector = Array.isArray(res.rows) && res.rows.length > 0;
    } catch (error) {
      diagnostics = await getElectronDiagnostics(electronDB);
      hasVector = false;
      logger.warn('Failed to detect pgvector extension over IPC', { diagnostics, error });
    }
    if (!hasVector) {
      if (!diagnostics) {
        diagnostics = await getElectronDiagnostics(electronDB);
      }
      logger.error('Desktop database initialization missing pgvector extension', { diagnostics });
      throw new Error(
        formatDesktopDatabaseInitError(diagnostics, 'Desktop database failed to initialize.')
      );
    }
    const chunkRepo = new ElectronFileChunkRepository(repositoryDb);

    // Dynamic imports via module-level helpers (avoids import() in component scope);
    // the two repository modules are independent, so load them concurrently.
    const [ElectronEmbeddingSetsRepo, ElectronViewFilterPresetsRepo] = await Promise.all([
      loadElectronEmbeddingSetsRepository(),
      loadElectronViewFilterPresetsRepository(),
    ]);
    const embeddingSetsRepo = new ElectronEmbeddingSetsRepo(repositoryDb);
    const viewFilterPresetsRepo = new ElectronViewFilterPresetsRepo(repositoryDb);

    bridge = electronDB;
    return {
      chunkRepository: chunkRepo,
      drizzleDb: null,
      embeddingSetsRepository: embeddingSetsRepo,
      exposedDb: createDbHandle(electronDB as unknown as QueryExecutor),
      fileRecordRepository: repository,
      vectorEnabled: hasVector,
      viewFilterPresetsRepository: viewFilterPresetsRepo,
    };
  };

  const clearAllData = async (): Promise<ClearAllDataResult> => {
    const electronDB = getDesktopDatabaseBridge();
    if (!electronDB?.clearAll) {
      throw new Error('Electron IPC clearAll method not available');
    }

    const result = await electronDB.clearAll('CONFIRM_CLEAR_DATABASE');
    if (result.success) {
      return {
        deletedChunks: result.deletedChunks || 0,
        deletedFiles: result.deletedFiles || 0,
      };
    }
    throw new Error(result.message || 'Failed to clear database via Electron IPC');
  };

  const clearQueuesAndEmbeddingSets = async (): Promise<void> => {
    const electronDb = getDesktopDatabaseBridge();
    if (!electronDb?.query) {
      return;
    }
    try {
      await electronDb.query('DELETE FROM job_queue');
    } catch (err) {
      logger.warn('Electron query to clear job_queue failed:', err);
    }
    try {
      await electronDb.query('DELETE FROM collection_indexing_stats');
    } catch (err) {
      logger.warn('Electron query to clear collection_indexing_stats failed:', err);
    }
    try {
      await electronDb.query('DELETE FROM embedding_sets');
    } catch (err) {
      logger.warn('Electron query to clear embedding_sets failed:', err);
    }
  };

  const hardReset = async (): Promise<boolean> => {
    if (!isAvailable()) {
      // NOT `return false`. `false` means "runtime, run your own drain → purge
      // → close instead", and the runtime's local sequence can never reset a
      // database the MAIN process owns: `purgeAndClose()` below has nothing to
      // purge, so the reset would resolve having destroyed nothing and the
      // caller would reload into the same profile. `hardReset()` is only ever
      // called on the ALREADY-SELECTED transport, so a capability that passed
      // selection and then failed here is a broken bridge, not a routing
      // choice — and `factory-reset.test.tsx` already pins the sibling rule
      // ("surfaces desktop hard reset failure instead of falling back to
      // direct PGlite") for a resetLocal that reports failure.
      throw new Error(
        'Electron database bridge became unavailable before the desktop factory reset ran. ' +
          'Refusing to fall through to the renderer-local purge, which cannot reset a ' +
          'main-process-owned database.'
      );
    }
    const electronDb = getDesktopDatabaseBridge();
    if (typeof electronDb?.resetLocal !== 'function') {
      throw new Error('Electron database reset bridge is unavailable.');
    }

    const res = await electronDb.resetLocal();
    if (!res?.success) {
      throw new Error(res?.message ?? 'Electron database reset failed.');
    }
    // Don't reload here - let the caller handle clearing UI state and reloading.
    // This ensures clearPersistentUiState() runs before the page reloads.
    return true;
  };

  return {
    cleanupAfterReset: () => Promise.resolve(),
    clearAllData,
    clearQueuesAndEmbeddingSets,
    // The main process owns the database; the renderer has nothing to close.
    detachConnection: () => {
      bridge = null;
      return null;
    },
    hardReset,
    hasOpenConnection: () => bridge !== null,
    isAvailable,
    kind: 'electron-ipc',
    open,
    // `hardReset()` handles every desktop reset, so the runtime's purge/close
    // leg must never run against this transport. It is an ASSERTION, not a
    // no-op: the renderer cannot purge a database the main process owns, so
    // resolving here would report a factory reset that destroyed nothing —
    // exactly the silent success `hardReset()` above refuses to produce. The
    // only way to arrive is `hardReset()` returning false, which it no longer
    // does.
    purgeAndClose: () =>
      Promise.reject(
        new Error(
          'The renderer cannot purge the desktop database: the main process owns it. ' +
            'Reaching this means a factory reset fell through hardReset().'
        )
      ),
  };
}
