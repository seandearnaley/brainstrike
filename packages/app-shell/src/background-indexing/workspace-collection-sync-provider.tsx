import {
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem, useOptionalFileTreeContext } from '@brainstrike/file-explorer-ui';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { createLogger } from '@brainstrike/utils/logger';
import { useSharedEmbeddingRuntime } from '@brainstrike/vector-management';
import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';

const logger = createLogger('WorkspaceCollectionSyncProvider');
export const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed';

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
}

export function WorkspaceCollectionSyncProvider({
  children,
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle } = useFileSystem();
  const fileTreeContext = useOptionalFileTreeContext();
  const db = usePGliteDatabase();
  const fileRecordRepository = useFileRecordRepository();
  const chunkRepository = useFileChunkRepository();
  const embeddingSetsRepository = useEmbeddingSetsRepository();
  const { ensureStarted: ensureChunkingWorker } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const setIsImporting = useVectorStatusUIStore((state) => state.setIsImporting);
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);
  const { controller: runtimeController, service: vectorQueueService } =
    useSharedEmbeddingRuntime();

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
        fileSystemAdapter &&
        fileRecordRepository &&
        chunkRepository &&
        embeddingSetsRepository
      )
    ) {
      return null;
    }
    return new WorkspaceCollectionSyncService({
      cancelBackfill: async (embeddingSetId) => {
        await runtimeController.cancelBackfill(embeddingSetId);
      },
      chunkRepository,
      db,
      embeddingSetsRepository,
      enqueueBackfill: async (embeddingSetId, options) => {
        return await runtimeController.enqueueBackfill(embeddingSetId, options);
      },
      ensureChunkingWorker,
      ensureEmbeddingRuntimeStarted,
      fileSystemAdapter,
      fileRecordRepository,
      getBackfillsInFlight: async () => await runtimeController.getBackfillsInFlight(),
      log: logger,
      setImporting: setIsImporting,
      setStatus: setSyncStatus,
      subscribeToBackfillProgress: (callback) => runtimeController.onBackfillProgress(callback),
      validateHostedProviderAccess,
    });
  }, [
    chunkRepository,
    db,
    embeddingSetsRepository,
    ensureEmbeddingRuntimeStarted,
    ensureChunkingWorker,
    fileRecordRepository,
    fileSystemAdapter,
    runtimeController,
    setIsImporting,
    setSyncStatus,
    validateHostedProviderAccess,
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

    if (!(enabled && managedCollectionId && rootDirectoryHandle)) {
      void service.sync({
        enabled,
        indexingPolicyPreset,
        managedCollectionId,
        rootDirectoryHandle,
      });
      return;
    }

    if (isAccessLoading) {
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

    if (fileTreeContext !== null && !fileTreeContext.isRestorationSettled) {
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

    void service.sync({
      enabled,
      indexingPolicyPreset,
      managedCollectionId,
      rootDirectoryHandle,
    });
  }, [
    enabled,
    indexingPolicyPreset,
    isAccessLoading,
    managedCollectionId,
    resetSyncStatus,
    rootDirectoryHandle,
    fileTreeContext?.isRestorationSettled,
    service,
    setSyncStatus,
  ]);

  useEffect(() => {
    triggerSync();
    return () => {
      void service?.cancel();
      setIsImporting(false);
    };
  }, [service, triggerSync, setIsImporting]);

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
