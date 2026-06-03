import {
  applyManagedCacheBatch as applyManagedCacheBatchLocally,
  createDatabasePressureController,
  createPriorityDbHandle,
  type DbHandle,
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  getDatabaseWorkScheduler,
  usePGliteDatabase,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useOptionalFileTreeContext } from '@brainstrike/file-explorer-ui/tree';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import {
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { useSharedEmbeddingRuntime } from '@brainstrike/vector-management';
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';

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

export function WorkspaceCollectionSyncProvider({
  children,
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle } = useFileSystem();
  const fileTreeContext = useOptionalFileTreeContext();
  const db = usePGliteDatabase();
  const backgroundDb = useMemo(() => (db ? createPriorityDbHandle(db, 'background') : null), [db]);
  const waitForBackgroundPermit = useMemo(
    () => (backgroundDb ? createWaitForBackgroundPermit(backgroundDb) : null),
    [backgroundDb]
  );
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
  const backgroundWorkSnapshot = useSyncExternalStore(
    subscribeToBackgroundWorkArbiter,
    getBackgroundWorkArbiterSnapshot,
    getBackgroundWorkArbiterSnapshot
  );

  const reportAsyncError = useCallback(
    (operation: string, error: unknown): void => {
      logger.error(`Workspace collection sync ${operation} failed`, { error });
      setSyncStatus({
        state: 'error',
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
    runtimeController,
    setManagedCollectionId,
    setSyncStatus,
    validateHostedProviderAccess,
    waitForBackgroundPermit,
  ]);

  const triggerSync = useCallback(() => {
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
    indexingPolicyPreset,
    isAccessLoading,
    isTreeRestorationReady,
    managedCollectionId,
    reportAsyncError,
    resetSyncStatus,
    rootDirectoryHandle,
    service,
    setSyncStatus,
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

  return <>{children}</>;
}
