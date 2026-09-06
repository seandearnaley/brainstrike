/**
 * The renderer database runtime: a platform-agnostic state machine that owns
 * initialization, the clear paths, factory reset and disposal. NO React — the
 * only React in this subsystem is `db-provider.tsx`, which subscribes to this
 * store with `useSyncExternalStore` and publishes the context value.
 *
 * It exists because every lifecycle invariant below used to be reachable ONLY
 * through a jsdom mount/unmount of `DbProvider`, while the failure mode being
 * guarded is a *wedged event loop* (`PGlite.close()` deactivates the WASM
 * backend before draining, so an overlapping statement spins forever —
 * BST-1320). `database-runtime.test.ts` now exercises those orderings with
 * fake transports and no render cycle.
 *
 * ## Drains mean canonical join points only
 *
 * Quoting `docs/agents/database.md` ("CLOSING a PGlite: drain first") verbatim:
 *
 * > Drains mean **canonical join points only** — sleeps, `SELECT 1` flushes,
 * > and `Promise.race` timeouts are rejected (a narrowed window is silent
 * > degradation, and no timer can fire against the blocked event loop anyway).
 *
 * The sanctioned web seams live in `db-reset-drain.ts`; this module composes
 * them and NOTHING else. Do not add a sleep, a flush query, or a race here.
 *
 * ## Transport selection is capability-based
 *
 * `resolveTransport` picks the first transport whose `isAvailable()` probe
 * passes — for the desktop transport that is "does `window.electronAPI?.db`
 * exist", never an `isElectron()` check (AGENTS.md). When no transport is
 * available the runtime THROWS rather than degrading to something that
 * half-works.
 */
import { createLogger } from '@brainstrike/logging';
import { isDevEnv } from '@brainstrike/utils';
import {
  createDatabaseWorkScheduler,
  type DatabaseWorkScheduler,
} from './database-work-scheduler.js';
import type { DbHandle } from './db-handle.js';
import {
  createLiveQueryDrainRegistry,
  createResetBarrierDatabaseWork,
  type LiveQueryDrainRegistry,
  type ResetBarrierDatabaseWork,
  waitForDatabaseWorkSchedulerIdle,
} from './db-reset-drain.js';
import type { DrizzleDb } from './drizzle/database.js';
import type { DrizzleFileChunkRepository } from './repositories/drizzle/file-chunk-repository.js';
import type { DrizzleFileRecordRepository } from './repositories/drizzle/file-record-repository.js';
import type { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import type { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import type {
  IEmbeddingSetsRepository,
  IViewFilterPresetsRepository,
} from './repositories/interfaces.js';

/**
 * The log scope stays `DbProvider` across the runtime and both transports on
 * purpose: it is an OBSERVABLE contract, not an implementation detail. Warn+
 * records are persisted into `brainstrike_diagnostic_events` with their scope,
 * and the provider tests filter on it. Renaming it would silently orphan both.
 */
const logger = createLogger('DbProvider');

function logDatabaseError(message: string, error: unknown): void {
  logger.error({ err: error }, message);
}

export type DbInitializationStatus = 'idle' | 'initializing' | 'ready' | 'error';

export type EmbeddingSetsRepo = IEmbeddingSetsRepository;
export type ViewFilterPresetsRepo = IViewFilterPresetsRepository;

export interface DbRuntimeState {
  chunkRepository: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  drizzleDb: DrizzleDb | null;
  embeddingSetsRepository: EmbeddingSetsRepo | null;
  error: Error | null;
  exposedDb: DbHandle | null;
  fileRecordRepository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  initializationStatus: DbInitializationStatus;
  initializing: boolean;
  lazyInitialized: boolean;
  ready: boolean;
  vectorEnabled: boolean;
  viewFilterPresetsRepository: ViewFilterPresetsRepo | null;
}

/** Everything a successful IPC or direct-PGlite connection publishes at once. */
export type DbConnectionSnapshot = Pick<
  DbRuntimeState,
  | 'chunkRepository'
  | 'drizzleDb'
  | 'embeddingSetsRepository'
  | 'exposedDb'
  | 'fileRecordRepository'
  | 'vectorEnabled'
  | 'viewFilterPresetsRepository'
>;

export type DbRuntimeAction =
  | { type: 'provider-mounted' }
  | { type: 'initialize-started' }
  | { type: 'connection-ready'; connection: DbConnectionSnapshot }
  | { type: 'initialize-succeeded' }
  | { type: 'initialize-failed'; error: Error }
  | { type: 'initialize-settled' }
  | { type: 'connection-closed' }
  | { type: 'reset' };

export const INITIAL_DB_RUNTIME_STATE: DbRuntimeState = {
  chunkRepository: null,
  drizzleDb: null,
  embeddingSetsRepository: null,
  error: null,
  exposedDb: null,
  fileRecordRepository: null,
  initializationStatus: 'idle',
  initializing: false,
  lazyInitialized: false,
  ready: false,
  vectorEnabled: false,
  viewFilterPresetsRepository: null,
};

export function dbRuntimeReducer(state: DbRuntimeState, action: DbRuntimeAction): DbRuntimeState {
  switch (action.type) {
    case 'provider-mounted':
      return { ...state, ready: true };
    case 'initialize-started':
      return { ...state, initializationStatus: 'initializing', initializing: true };
    case 'connection-ready':
      return { ...state, ...action.connection, error: null, ready: true };
    case 'initialize-succeeded':
      return { ...state, initializationStatus: 'ready', lazyInitialized: true };
    case 'initialize-failed':
      // Connection-derived fields (drizzleDb, exposedDb, vectorEnabled) are
      // deliberately left as-is: a failure before connection-ready never set
      // them, and initialize's guards prevent re-entry afterwards.
      return {
        ...state,
        chunkRepository: null,
        embeddingSetsRepository: null,
        error: action.error,
        fileRecordRepository: null,
        initializationStatus: 'error',
        lazyInitialized: false,
        ready: true,
        viewFilterPresetsRepository: null,
      };
    case 'initialize-settled':
      return { ...state, initializing: false };
    case 'connection-closed':
      return { ...state, exposedDb: null };
    case 'reset':
      // `error` survives a reset: the caller (factoryReset) reloads the page,
      // and clearing it here would blank error UI during the teardown window.
      return { ...INITIAL_DB_RUNTIME_STATE, error: state.error };
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled DbProvider action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface ClearAllDataResult {
  readonly deletedChunks: number;
  readonly deletedFiles: number;
}

export type DatabaseTransportKind = 'electron-ipc' | 'pglite-direct';

export interface DatabaseTransportOpenContext {
  /**
   * True once `dispose()` has begun. A transport whose `open()` is still
   * awaiting the slow stretch (first-run bootstrap + initdb + extension load)
   * MUST check this before installing what it built and close it instead —
   * an abandoned `idb://` client holds its IndexedDB lock and the next open
   * fails with the "close other tabs" recovery error (BST-1329).
   */
  readonly isDisposed: () => boolean;
  /** The barrier-aware scheduler every scheduled statement must run through. */
  readonly scheduler: DatabaseWorkScheduler;
}

export interface DatabaseTransportClearContext {
  /** Re-entrant initialization for a clear that arrived before a connection. */
  readonly ensureInitialized: () => Promise<void>;
}

/**
 * One platform's database wiring. Implementations: `electron-ipc-transport.ts`
 * (main-mediated desktop bridge) and `pglite-direct-transport.ts` (the
 * renderer-owned PGlite, direct or worker-hosted).
 */
export interface DatabaseTransport {
  /** Storage cleanup AFTER the reset barrier released and state was cleared. */
  readonly cleanupAfterReset: () => Promise<void>;
  /** Deletes user rows without destroying the database ("Clear Database"). */
  readonly clearAllData: (context: DatabaseTransportClearContext) => Promise<ClearAllDataResult>;
  /** Empties `job_queue`, `collection_indexing_stats` and `embedding_sets`. */
  readonly clearQueuesAndEmbeddingSets: () => Promise<void>;
  /**
   * Forgets the local connection and returns the closer the caller must run,
   * or `null` when this transport owns nothing closable (the desktop bridge —
   * the main process owns that database). Split from `close()` so the runtime
   * can capture the closer, drop the reference, and only THEN drain and close.
   */
  readonly detachConnection: () => (() => Promise<void>) | null;
  /**
   * Transport-owned hard reset. `true` means it fully handled the reset (the
   * desktop path deletes the profile directory in the main process), and the
   * runtime skips its own drain → purge → close entirely.
   *
   * `false` is only legitimate for a transport whose OWN reset IS the runtime's
   * drain → purge → close — i.e. `pglite-direct`. A transport that owns no
   * closable connection must THROW rather than return `false`, because the
   * runtime's local leg would then find nothing to purge and resolve as a
   * factory reset that destroyed nothing (see `electron-ipc-transport.ts`).
   */
  readonly hardReset: () => Promise<boolean>;
  readonly hasOpenConnection: () => boolean;
  /** Capability probe. Never a platform check — see the module docblock. */
  readonly isAvailable: () => boolean;
  readonly kind: DatabaseTransportKind;
  /**
   * Bootstrap → open → migrate → repositories. `null` means the runtime was
   * disposed mid-open and the transport already closed what it built.
   */
  readonly open: (context: DatabaseTransportOpenContext) => Promise<DbConnectionSnapshot | null>;
  /** Purges every reset relation and closes the local connection. */
  readonly purgeAndClose: () => Promise<void>;
}

export interface DatabaseRuntime {
  readonly clearAllData: () => Promise<ClearAllDataResult>;
  readonly clearQueuesAndEmbeddingSets: () => Promise<void>;
  readonly databaseWork: ResetBarrierDatabaseWork;
  /**
   * Tears the runtime down. Resolves once the deferred close settled, so tests
   * can join it; the React cleanup fires and forgets. Idempotent.
   */
  readonly dispose: () => Promise<void>;
  readonly factoryReset: () => Promise<void>;
  readonly getState: () => DbRuntimeState;
  /** Bootstrap → open → migrate → repositories. Never rejects. */
  readonly initialize: () => Promise<void>;
  readonly liveQueryDrainRegistry: LiveQueryDrainRegistry;
  /** Mount marker: publishes `ready` without opening anything. */
  readonly start: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface DatabaseRuntimeOptions {
  /**
   * BST-1329: the scheduler is wrapped in a reset barrier so factory reset can
   * hold NEW submissions out while it drains in-flight work before close().
   */
  readonly databaseWork?: ResetBarrierDatabaseWork;
  /** Lets reset/dispose await unsubscribing every live handle. */
  readonly liveQueryDrainRegistry?: LiveQueryDrainRegistry;
  /** Probed in order; the first available one wins and is remembered. */
  readonly transports: readonly DatabaseTransport[];
}

/** Clear active embedding set ID from localStorage to prevent stale collection references */
function clearActiveEmbeddingSetIdFromStorage(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem('brainstrike.activeEmbeddingSetId');
    logger.info('[DbProvider] Cleared active embedding set ID from localStorage');
  } catch (err) {
    logger.warn('[DbProvider] Failed to clear active embedding set ID:', err);
  }
}

export function createDatabaseRuntime(options: DatabaseRuntimeOptions): DatabaseRuntime {
  const databaseWork =
    options.databaseWork ?? createResetBarrierDatabaseWork(createDatabaseWorkScheduler());
  const liveQueryDrainRegistry = options.liveQueryDrainRegistry ?? createLiveQueryDrainRegistry();

  let state = INITIAL_DB_RUNTIME_STATE;
  const listeners = new Set<() => void>();

  let activeTransport: DatabaseTransport | null = null;
  let disposed = false;
  let disposeSettled: Promise<void> | null = null;
  let initializingPromise: Promise<void> | null = null;
  let resetPendingReload = false;

  const dispatch = (action: DbRuntimeAction): void => {
    state = dbRuntimeReducer(state, action);
    for (const listener of listeners) {
      listener();
    }
  };

  const resolveTransport = (): DatabaseTransport => {
    if (activeTransport) {
      return activeTransport;
    }
    const available = options.transports.find((transport) => transport.isAvailable());
    if (!available) {
      throw new Error(
        'No database transport is available in this environment. ' +
          `Probed: ${options.transports.map((transport) => transport.kind).join(', ') || '(none)'}.`
      );
    }
    activeTransport = available;
    return available;
  };

  const initialize = async (): Promise<void> => {
    if (resetPendingReload) {
      return;
    }

    // Fast exits when already ready. The second clause is the pre-BST-1653
    // `connectionRef.current && !useElectronIPC` guard restated in terms of
    // the transport actually selected: a renderer-owned PGlite is already
    // open, so opening a second one would strand the first one's lock.
    if (
      state.lazyInitialized ||
      (activeTransport?.kind === 'pglite-direct' && activeTransport.hasOpenConnection())
    ) {
      return;
    }

    // If an initialization is in flight, wait for it
    if (initializingPromise) {
      await initializingPromise;
      return;
    }

    dispatch({ type: 'initialize-started' });
    logger.debug('Lazy-loading database (triggered by actual usage)');

    initializingPromise = (async () => {
      try {
        const transport = resolveTransport();
        const connection = await transport.open({
          isDisposed: () => disposed,
          scheduler: databaseWork.scheduler,
        });
        if (connection) {
          dispatch({ connection, type: 'connection-ready' });
        }
        dispatch({ type: 'initialize-succeeded' });
      } catch (err) {
        logDatabaseError('Failed to initialize database', err);
        dispatch({ error: err as Error, type: 'initialize-failed' });
      } finally {
        initializingPromise = null;
        dispatch({ type: 'initialize-settled' });
      }
    })();

    await initializingPromise;
  };

  /**
   * BST-1329: the canonical pre-close drain — **idle join, then seal, then
   * unsubscribe**, deliberately the REVERSE of the desktop's unsubscribe-first
   * double-cleanup (`resetDesktopDatabaseProfile`). Two reasons the web order
   * differs, both load-bearing:
   *
   * 1. **An aborted close must not kill live queries.** The idle join is the
   *    only step that can fail (timeout). Unsubscribing first would mean a
   *    failed reset leaves every handle permanently dead — `unsubscribe`
   *    latches the handle inactive and `usePGliteLiveQuery` never re-subscribes
   *    (no dep changed, no error state) — so the app would render stale rows
   *    forever with nothing logged. Joining idle first means that failure path
   *    leaves everything alive and subscribed.
   * 2. **The barrier already blocks new subscribes**, unlike the desktop side:
   *    `live.query`/`live.incrementalQuery` ARE scheduler work, so nothing can
   *    attach while the scheduler drains — which is what makes a single
   *    unsubscribe pass sufficient here.
   *
   * The seal closes the remaining tail: work that settled just before idle can
   * register its handle from a promise continuation landing after the drain's
   * snapshot. Past the seal the close is COMMITTED — unsubscribe failures warn
   * and proceed (`unsubscribeAll` never rejects). Runs on the renderer's OWN
   * scheduler and registry; reset callers must already hold the barrier.
   */
  const drainDatabaseWorkForClose = async (): Promise<void> => {
    await waitForDatabaseWorkSchedulerIdle(databaseWork.scheduler);
    liveQueryDrainRegistry.seal();
    await liveQueryDrainRegistry.unsubscribeAll();
  };

  const resetLocalDatabaseState = async (transport: DatabaseTransport): Promise<void> => {
    resetPendingReload = true;

    try {
      // Barrier up first: new scheduler submissions wait behind the reset, so
      // the drain can actually reach idle. The purge below runs on the RAW
      // connection (never the scheduled handle), so it cannot deadlock on its
      // own barrier. A drain failure (idle timeout) aborts the reset loudly —
      // closing anyway would trade a failed reset for a wedged renderer.
      await databaseWork.runWithResetBarrier(async () => {
        await drainDatabaseWorkForClose();
        if (transport.hasOpenConnection()) {
          await transport.purgeAndClose();
          dispatch({ type: 'connection-closed' });
        } else {
          logger.warn('[DbProvider] No active database to purge during factory reset');
        }
      });
    } catch (error) {
      resetPendingReload = false;
      // The database is still open and (when the idle join was what failed)
      // every live handle is still alive — reopen registration so the app keeps
      // working instead of silently losing live updates until a reload.
      liveQueryDrainRegistry.unseal();
      throw error;
    }

    dispatch({ type: 'reset' });

    // Clear active embedding set ID from localStorage to prevent stale collections
    clearActiveEmbeddingSetIdFromStorage();

    await transport.cleanupAfterReset();
  };

  const factoryReset = async (): Promise<void> => {
    const transport = resolveTransport();
    const handled = await transport.hardReset();
    if (handled) {
      logger.info('[DbProvider] Electron hard reset completed');
      return;
    }

    await resetLocalDatabaseState(transport);
  };

  const closeAfterDrain = async (closeConnection: () => Promise<void>): Promise<void> => {
    // The initialization promise never rejects (failures are dispatched into
    // runtime state), so a bare await is safe.
    const initInFlight = initializingPromise;
    if (initInFlight) {
      await initInFlight;
    }
    try {
      await drainDatabaseWorkForClose();
    } catch (error) {
      logger.error('[DbProvider] Skipping unmount close: database work never drained', error);
      return;
    }
    await closeConnection();
  };

  const dispose = async (): Promise<void> => {
    if (disposed) {
      await (disposeSettled ?? Promise.resolve());
      return;
    }
    // BST-1329: an unmount during the transport's slow open stretch sees no
    // connection at all. `DatabaseTransportOpenContext.isDisposed` is how the
    // transport learns to close the instance that resolves a moment later
    // instead of leaking its IndexedDB lock.
    disposed = true;

    const closeConnection = activeTransport?.detachConnection() ?? null;
    if (!closeConnection || isDevEnv()) {
      // Dev keeps the instance open on purpose: Fast Refresh remounts the
      // provider and a closed PGlite would take the next mount down with it.
      disposeSettled = Promise.resolve();
      return;
    }

    // `detachConnection` also fires BEFORE `migrate()` has finished, so a
    // dispose can observe a connection whose init statements are still in
    // flight — closing under them is the BST-1320 synchronous wedge. Deferred
    // by one macrotask so the caller's teardown returns immediately.
    disposeSettled = new Promise<void>((resolve) => {
      setTimeout(() => {
        void closeAfterDrain(closeConnection).finally(resolve);
      }, 0);
    });
    await disposeSettled;
  };

  const clearAllData = async (): Promise<ClearAllDataResult> => {
    // Initialize database if not already initialized
    if (!state.lazyInitialized) {
      await initialize();
    }
    const transport = resolveTransport();
    return await transport.clearAllData({ ensureInitialized: initialize });
  };

  const clearQueuesAndEmbeddingSets = async (): Promise<void> => {
    const transport = resolveTransport();
    await transport.clearQueuesAndEmbeddingSets();
  };

  return {
    clearAllData,
    clearQueuesAndEmbeddingSets,
    databaseWork,
    dispose,
    factoryReset,
    getState: () => state,
    initialize,
    liveQueryDrainRegistry,
    start: () => {
      dispatch({ type: 'provider-mounted' });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
