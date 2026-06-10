import {
  applyManagedCacheBatch as applyManagedCacheBatchLocally,
  createDatabasePressureController,
  createPriorityDbHandle,
  type DatabaseWorkSchedulerSnapshot,
  type DbHandle,
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  usePGliteDatabase,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useOptionalFileTreeContext } from '@brainstrike/file-explorer-ui/tree';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import {
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/utils/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
import { useSharedEmbeddingRuntime } from '@brainstrike/vector-management';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getAssistantForegroundActivitySnapshot } from '../assistant-foreground-activity';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import { useResyncOnReturnToVisibility } from './use-resync-on-return-to-visibility';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';
import {
  isWorkspaceIndexBlockedError,
  WorkspaceIndexBlockedError,
} from './workspace-index-blocked-error';
import { bootstrapWorkspaceIndexCollection } from './workspace-index-bootstrap-service';

const logger = createLogger('WorkspaceCollectionSyncProvider');
export const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed';
/**
 * The sync service signals foreground-style import progress through `setImporting`.
 * Background indexing intentionally discards it: the global `isImporting` flag is
 * the foreground bulk-import pause switch for collection live queries, and raising
 * it would freeze the collection selector + counts at 0/0 during background work.
 */
const NOOP_SET_IMPORTING = (_active: boolean): void => {
  // intentionally empty — see comment above
};
const BACKGROUND_DATABASE_WORK_OPTIONS = {
  label: 'background indexing',
  priority: 'background',
} as const;
const BACKGROUND_PRESSURE_POLL_MS = 50;
const BACKGROUND_POWER_SNAPSHOT_CACHE_MS = 1000;
const RECENT_USER_INPUT_WINDOW_MS = 30_000;

function createClearedProgressPatch(): Pick<
  WorkspaceCollectionSyncStatusPatch,
  | 'backfillRequestId'
  | 'blockedReason'
  | 'chunkingProgress'
  | 'currentFilePath'
  | 'embeddingProgress'
  | 'importProgress'
  | 'lastError'
  | 'pauseReasons'
  | 'processedFiles'
  | 'queueProgress'
  | 'queuedFiles'
  | 'scanSummary'
> {
  return {
    backfillRequestId: null,
    blockedReason: null,
    currentFilePath: null,
    scanSummary: null,
    importProgress: null,
    chunkingProgress: null,
    embeddingProgress: null,
    queueProgress: null,
    queuedFiles: 0,
    processedFiles: 0,
    lastError: null,
    pauseReasons: [],
  };
}

interface WorkspaceIndexingPowerBridge {
  getSnapshot?: () => Promise<WorkspaceIndexingPowerSnapshot>;
}

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
}

function createBackgroundRepositoryDb(db: DbHandle): {
  exec: (sql: string) => Promise<void>;
  query: DbHandle['query'];
} {
  if (!db.exec) {
    throw new Error('Background indexing requires database exec support.');
  }
  return {
    query: db.query,
    exec: async (sql: string) => {
      await db.exec?.(sql);
    },
  };
}

function createWaitForBackgroundPermit(
  db: DbHandle
): (options: { readonly label: string }) => Promise<void> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return createDatabasePressureController({ scheduler }).waitForBackgroundPermit;
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Background indexing requires database QoS scheduler snapshots.');
  }

  return createDatabasePressureController({
    pollMs: BACKGROUND_PRESSURE_POLL_MS,
    snapshotSource: {
      getSnapshot: schedulerSnapshot,
    },
  }).waitForBackgroundPermit;
}

function toWorkspaceIndexingDatabasePressure(
  snapshot: DatabaseWorkSchedulerSnapshot
): WorkspaceIndexingDatabasePressure {
  const waitingReason = getDatabasePressureWaitingReason(snapshot, snapshot.snapshotAt);
  const normalPressure = waitingReason?.startsWith('normal-') === true;
  return {
    available: true,
    foregroundPressure: waitingReason !== null && !normalPressure,
    normalPressure,
  };
}

function createReadDatabasePressure(
  db: DbHandle
): () => Promise<WorkspaceIndexingDatabasePressure> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return async () => toWorkspaceIndexingDatabasePressure(scheduler.getSnapshot());
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Workspace Index QoS requires database scheduler snapshots.');
  }

  return async () => toWorkspaceIndexingDatabasePressure(await schedulerSnapshot());
}

function createReadPowerSnapshot(): (() => Promise<WorkspaceIndexingPowerSnapshot>) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { power?: WorkspaceIndexingPowerBridge }).power;
  const getSnapshot = bridge?.getSnapshot;
  if (typeof getSnapshot !== 'function') {
    return null;
  }
  return createCachedSnapshotReader(
    async () => assertValidWorkspaceIndexingPowerSnapshot(await getSnapshot()),
    BACKGROUND_POWER_SNAPSHOT_CACHE_MS
  );
}

function createCachedSnapshotReader<TSnapshot>(
  readSnapshot: () => TSnapshot | Promise<TSnapshot>,
  cacheMs: number,
  now: () => number = () => Date.now()
): () => Promise<TSnapshot> {
  let cachedSnapshot: TSnapshot | null = null;
  let cachedAt = 0;
  let pendingSnapshot: Promise<TSnapshot> | null = null;
  return async () => {
    const readAt = now();
    if (cachedSnapshot && readAt - cachedAt <= cacheMs) {
      return cachedSnapshot;
    }
    if (pendingSnapshot) {
      return pendingSnapshot;
    }
    cachedSnapshot = null;
    cachedAt = 0;
    pendingSnapshot = Promise.resolve()
      .then(readSnapshot)
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedAt = now();
        return snapshot;
      });
    try {
      return await pendingSnapshot;
    } finally {
      pendingSnapshot = null;
    }
  };
}

function useDocumentVisibility(): boolean {
  const readVisibility = (): boolean =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible';
  const [visible, setVisible] = useState(readVisibility);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = (): void => {
      setVisible(readVisibility());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return visible;
}

function useRecentUserInputMsReader(): () => number | null {
  const lastInputRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const recordInput = (): void => {
      lastInputRef.current = Date.now();
    };
    const inputEvents = ['keydown', 'pointerdown', 'wheel'] as const;
    for (const eventName of inputEvents) {
      window.addEventListener(eventName, recordInput, { passive: true });
    }
    return () => {
      for (const eventName of inputEvents) {
        window.removeEventListener(eventName, recordInput);
      }
    };
  }, []);

  return useCallback((): number | null => {
    const lastInputAt = lastInputRef.current;
    if (lastInputAt === null) {
      return null;
    }
    const inputAgeMs = Math.max(0, Date.now() - lastInputAt);
    return inputAgeMs > RECENT_USER_INPUT_WINDOW_MS ? null : inputAgeMs;
  }, []);
}

export function WorkspaceCollectionSyncProvider({
  children,
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle } = useFileSystem();
  const fileTreeContext = useOptionalFileTreeContext();
  const db = usePGliteDatabase();

  // Root registry: ensure a DB roots row exists for every adapter root.
  // Runs once per boot, before the first sync cycle writes file records.
  // Errors are logged and swallowed — must never block boot.
  useRootsReconciliation({ adapter: fileSystemAdapter, db });

  const backgroundDb = useMemo(() => (db ? createPriorityDbHandle(db, 'background') : null), [db]);
  const waitForBackgroundPermit = useMemo(
    () => (backgroundDb ? createWaitForBackgroundPermit(backgroundDb) : null),
    [backgroundDb]
  );
  const readDatabasePressure = useMemo(
    () => (backgroundDb ? createReadDatabasePressure(backgroundDb) : null),
    [backgroundDb]
  );
  const readPowerSnapshot = useMemo(() => createReadPowerSnapshot(), []);
  const backgroundRepositories = useMemo(() => {
    if (!backgroundDb) {
      return null;
    }
    const repositoryDb = createBackgroundRepositoryDb(backgroundDb);
    return {
      chunkRepository: new ElectronFileChunkRepository(repositoryDb),
      embeddingSetsRepository: new ElectronEmbeddingSetsRepository(repositoryDb),
      fileRecordRepository: new ElectronFileRecordRepository(repositoryDb),
    };
  }, [backgroundDb]);
  const { ensureStarted: ensureChunkingWorker } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const hasHydrated = useBackgroundIndexingPreferencesStore((state) => state.hasHydrated);
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const setManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.setManagedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);
  const { controller: runtimeController, service: vectorQueueService } =
    useSharedEmbeddingRuntime();
  const windowVisible = useDocumentVisibility();
  const readRecentUserInputMs = useRecentUserInputMsReader();
  const windowVisibleRef = useRef(windowVisible);
  windowVisibleRef.current = windowVisible;
  const workspaceIndexBootstrapInFlightRef = useRef(false);
  const backgroundWorkSnapshot = useSyncExternalStore(
    subscribeToBackgroundWorkArbiter,
    getBackgroundWorkArbiterSnapshot,
    getBackgroundWorkArbiterSnapshot
  );

  const reportAsyncError = useCallback(
    (operation: string, error: unknown): void => {
      logger.error(`Workspace collection sync ${operation} failed`, { error });
      if (isWorkspaceIndexBlockedError(error)) {
        setSyncStatus({
          state: 'blocked',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          ...createClearedProgressPatch(),
          blockedReason: error.blockedReason,
          lastError: error.message,
        });
        return;
      }
      setSyncStatus({
        state: 'error',
        blockedReason: null,
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle?.path ?? null,
        currentFilePath: null,
        queuedFiles: 0,
        processedFiles: 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    },
    [managedCollectionId, rootDirectoryHandle?.path, setSyncStatus]
  );
  const isTreeRestorationReady =
    fileTreeContext === null ||
    (!(fileTreeContext.isLoading || fileTreeContext.isRestoringExpandedPaths) &&
      fileTreeContext.isRestorationSettled);

  const validateHostedProviderAccess = useCallback(
    async (embeddingSetId: string): Promise<void> => {
      if (!vectorQueueService) {
        throw new Error('Vector queue service is unavailable.');
      }
      const validation = await vectorQueueService.validateApiKeyForSet(embeddingSetId);
      if (!validation.valid) {
        if (validation.reason === 'missing-provider-key') {
          throw new WorkspaceIndexBlockedError('missing-provider-key', validation.message);
        }
        throw new Error(validation.message);
      }
    },
    [vectorQueueService]
  );

  const ensureEmbeddingRuntimeStarted = useCallback(async (): Promise<void> => {
    const status = await runtimeController.ensureStarted();
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Embedding runtime is unavailable.');
    }
  }, [runtimeController]);

  // useState lazy initializer guarantees one transition tracker per provider
  // instance: the sync loop re-resolves the QoS policy every cycle, and the
  // tracker logs only (state, reason) transitions instead of every resolution.
  const [observeQosTransition] = useState(() =>
    createWorkspaceIndexingQosTransitionLogger('app-shell-sync')
  );

  const resolveQosPolicy = useCallback(async (): Promise<WorkspaceIndexingQosPolicy> => {
    if (!readDatabasePressure) {
      throw new Error('Workspace Index QoS requires database scheduler snapshots.');
    }
    const powerSnapshot = readPowerSnapshot ? await readPowerSnapshot() : null;
    const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
    const policy = resolveWorkspaceIndexingQosPolicy({
      dbPressure: await readDatabasePressure(),
      // Coarse app-shell signal: this spans the full assistant turn so background
      // indexing yields while tool/LLM work is active. The desktop hidden-host
      // ForegroundEmbeddingGate remains the embedding-scoped GPU coordination path.
      foregroundQueryActive: getAssistantForegroundActivitySnapshot(),
      idleState: powerSnapshot?.idleState ?? 'unknown',
      idleTimeMs: powerSnapshot?.idleTimeMs ?? null,
      manualPaused: latestBackgroundWorkSnapshot.backgroundIndexingPaused,
      powerSource: powerSnapshot?.powerSource ?? 'unknown',
      // TODO(workspace-index-qos): wire hosted provider rate-limit telemetry when
      // backfill exposes provider throttling as durable state.
      providerRateLimited: false,
      recentUserInputMs: readRecentUserInputMs(),
      thermalState: powerSnapshot?.thermalState ?? 'unknown',
      windowVisible: windowVisibleRef.current,
    });
    observeQosTransition(policy);
    return policy;
  }, [observeQosTransition, readDatabasePressure, readPowerSnapshot, readRecentUserInputMs]);

  const service = useMemo(() => {
    if (
      !(
        db &&
        backgroundDb &&
        waitForBackgroundPermit &&
        backgroundRepositories &&
        fileSystemAdapter &&
        backgroundRepositories.fileRecordRepository &&
        backgroundRepositories.chunkRepository &&
        backgroundRepositories.embeddingSetsRepository
      )
    ) {
      return null;
    }
    return new WorkspaceCollectionSyncService({
      applyManagedCacheBatch: async (args) => {
        const electronApplyManagedCacheBatch = window.electronAPI?.db?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      },
      cancelBackfill: async (embeddingSetId) => {
        await runtimeController.cancelBackfill(embeddingSetId);
      },
      chunkRepository: backgroundRepositories.chunkRepository,
      db: backgroundDb,
      embeddingSetsRepository: backgroundRepositories.embeddingSetsRepository,
      enqueueBackfill: async (embeddingSetId, options) =>
        await runtimeController.enqueueBackfill(embeddingSetId, options),
      ensureChunkingWorker,
      ensureEmbeddingRuntimeStarted,
      fileSystemAdapter,
      fileRecordRepository: backgroundRepositories.fileRecordRepository,
      getBackfillsInFlight: async () => await runtimeController.getBackfillsInFlight(),
      log: logger,
      onManagedCollectionMissing: (missingCollectionId) => {
        if (
          useBackgroundIndexingPreferencesStore.getState().managedCollectionId ===
          missingCollectionId
        ) {
          setManagedCollectionId(null);
        }
      },
      resolveQosPolicy,
      // Background indexing must NOT raise the foreground `isImporting` pause flag:
      // that flag gates the collection selector + count live queries
      // (liveQueryEnabled = !isImporting), so toggling it freezes the file/chunk
      // counts the user is watching at 0/0 for the whole import. Background progress
      // is reported through the workspace-sync status store instead.
      setImporting: NOOP_SET_IMPORTING,
      setStatus: setSyncStatus,
      subscribeToBackfillProgress: (callback) => runtimeController.onBackfillProgress(callback),
      validateHostedProviderAccess,
      waitForBackgroundPermit,
    });
  }, [
    backgroundDb,
    backgroundRepositories,
    db,
    ensureEmbeddingRuntimeStarted,
    ensureChunkingWorker,
    fileSystemAdapter,
    resolveQosPolicy,
    runtimeController,
    setManagedCollectionId,
    setSyncStatus,
    validateHostedProviderAccess,
    waitForBackgroundPermit,
  ]);

  const triggerWorkspaceIndexBootstrap = useCallback((): boolean => {
    if (!(enabled && managedCollectionId === null)) {
      return false;
    }
    if (workspaceIndexBootstrapInFlightRef.current) {
      return true;
    }

    const embeddingSetsRepository = backgroundRepositories?.embeddingSetsRepository;
    if (!embeddingSetsRepository) {
      reportAsyncError(
        'bootstrap',
        new Error('Background indexing embedding set repository is unavailable.')
      );
      return true;
    }

    workspaceIndexBootstrapInFlightRef.current = true;
    void bootstrapWorkspaceIndexCollection(
      { enabled, managedCollectionId },
      {
        embeddingSetsRepository,
        setManagedCollectionId,
      }
    )
      .then((collection) => {
        if (!collection) {
          return;
        }
        const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
        if (latestBackgroundWorkSnapshot.backgroundIndexingPaused) {
          setSyncStatus({
            state: 'paused',
            managedCollectionId: collection.id,
            managedCollectionName: collection.name ?? null,
            activeRootPath: rootDirectoryHandle?.path ?? null,
            currentFilePath: null,
            queuedFiles: 0,
            processedFiles: 0,
            lastError: null,
            pauseReasons: [
              ...(latestBackgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
              ...getBackgroundWorkPauseReasonLabels(
                latestBackgroundWorkSnapshot.automaticPauseReasons
              ),
            ],
          });
          return;
        }
        setSyncStatus({
          state: 'idle',
          managedCollectionId: collection.id,
          managedCollectionName: collection.name ?? null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
          pauseReasons: [],
        });
      })
      .catch((error) => {
        reportAsyncError('bootstrap', error);
      })
      .finally(() => {
        workspaceIndexBootstrapInFlightRef.current = false;
      });
    return true;
  }, [
    backgroundRepositories,
    enabled,
    managedCollectionId,
    reportAsyncError,
    rootDirectoryHandle?.path,
    setManagedCollectionId,
    setSyncStatus,
  ]);

  const triggerSync = useCallback(() => {
    if (!hasHydrated) {
      return;
    }

    if (!service) {
      if (enabled) {
        setSyncStatus({
          state: 'error',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: 'Background indexing runtime is unavailable.',
        });
      } else {
        resetSyncStatus();
      }
      return;
    }

    if (triggerWorkspaceIndexBootstrap()) {
      return;
    }

    if (backgroundWorkSnapshot.backgroundIndexingPaused) {
      void service.cancel().catch((error) => {
        reportAsyncError('cancel', error);
      });
      setSyncStatus({
        state: 'paused',
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle?.path ?? null,
        currentFilePath: null,
        lastError: null,
        pauseReasons: [
          ...(backgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
          ...getBackgroundWorkPauseReasonLabels(backgroundWorkSnapshot.automaticPauseReasons),
        ],
      });
      return;
    }

    if (!(enabled && managedCollectionId && rootDirectoryHandle)) {
      void service
        .sync({
          enabled,
          indexingPolicyPreset,
          managedCollectionId,
          rootDirectoryHandle,
        })
        .catch((error) => {
          reportAsyncError('sync', error);
        });
      return;
    }

    if (isAccessLoading) {
      void service.cancel();
      setSyncStatus({
        state: 'waiting',
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle.path,
        currentFilePath: null,
        queuedFiles: 0,
        processedFiles: 0,
        lastError: null,
      });
      return;
    }

    if (!isTreeRestorationReady) {
      void service.cancel();
      setSyncStatus({
        state: 'waiting',
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle.path,
        currentFilePath: null,
        queuedFiles: 0,
        processedFiles: 0,
        lastError: null,
      });
      return;
    }

    void service
      .sync({
        enabled,
        indexingPolicyPreset,
        managedCollectionId,
        rootDirectoryHandle,
      })
      .catch((error) => {
        reportAsyncError('sync', error);
      });
  }, [
    backgroundWorkSnapshot,
    enabled,
    hasHydrated,
    indexingPolicyPreset,
    isAccessLoading,
    isTreeRestorationReady,
    managedCollectionId,
    reportAsyncError,
    resetSyncStatus,
    rootDirectoryHandle,
    service,
    setSyncStatus,
    triggerWorkspaceIndexBootstrap,
  ]);

  useEffect(() => {
    setBackgroundWorkManualPause(paused);
    return () => {
      setBackgroundWorkManualPause(false);
    };
  }, [paused]);

  useEffect(() => {
    if (!service) {
      return;
    }
    return registerBackgroundWorkPauseHandler('background-indexing', {
      pause: async () => {
        await service.cancel();
      },
    });
  }, [service]);

  useEffect(() => {
    triggerSync();
    return () => {
      void service?.cancel().catch((error) => {
        reportAsyncError('cancel', error);
      });
    };
  }, [reportAsyncError, service, triggerSync]);

  useEffect(() => {
    const handleRefresh = (): void => {
      triggerSync();
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    };
  }, [triggerSync]);

  // Recovery point for a backfill killed while the window was hidden (e.g. a
  // top-level navigation mid-backfill): re-sync on return to visibility so the
  // 0-changes coverage check can re-enqueue any missing embedding work.
  useResyncOnReturnToVisibility(triggerSync);

  return <>{children}</>;
}
