import type { EmbeddingSet } from '@brainstrike/db';
import {
  JobQueue,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import { createLogger } from '@brainstrike/utils/logger';
import { createVectorQueueService } from '@brainstrike/vector-management';
import { type ReactNode, useCallback, useEffect, useMemo } from 'react';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';

const logger = createLogger('WorkspaceCollectionSyncProvider');
export const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed';

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
  loadEmbeddingQueue?: (() => Promise<import('@brainstrike/queue').QueueAdapter>) | null;
}

export function WorkspaceCollectionSyncProvider({
  children,
  loadEmbeddingQueue = null,
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { rootDirectoryHandle } = useFileSystem();
  const db = usePGliteDatabase();
  const fileRecordRepository = useFileRecordRepository();
  const chunkRepository = useFileChunkRepository();
  const embeddingSetsRepository = useEmbeddingSetsRepository();
  const { port: chunkingWorkerPort } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const devicePreference = useVectorPreferencesStore((state) => state.devicePref);
  const setIsImporting = useVectorStatusUIStore((state) => state.setIsImporting);
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);

  const vectorQueueService = useMemo(() => {
    if (!(db && chunkRepository)) {
      return null;
    }
    return createVectorQueueService({
      chunkRepository,
      db,
      jobQueue: new JobQueue(db),
    });
  }, [chunkRepository, db]);

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

  const validateLocalRuntime = useCallback(async (_collection: EmbeddingSet): Promise<void> => {
    const embeddingHost = (
      window as Window & {
        embeddingHost?: {
          ensureStarted?: () => Promise<{ lastError?: string | null; state: string }>;
        };
      }
    ).embeddingHost;

    if (embeddingHost?.ensureStarted) {
      const status = await embeddingHost.ensureStarted();
      if (status.state === 'error') {
        throw new Error(status.lastError ?? 'Local embedding runtime is unavailable.');
      }
    }
  }, []);

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
    if (!loadEmbeddingQueue) {
      return null;
    }
    return new WorkspaceCollectionSyncService({
      chunkRepository,
      chunkingWorkerPort,
      db,
      embeddingDeviceHint: devicePreference,
      embeddingSetsRepository,
      fileSystemAdapter,
      fileRecordRepository,
      loadEmbeddingQueue,
      log: logger,
      setImporting: setIsImporting,
      setStatus: setSyncStatus,
      validateHostedProviderAccess,
      validateLocalRuntime,
    });
  }, [
    chunkRepository,
    chunkingWorkerPort,
    db,
    devicePreference,
    embeddingSetsRepository,
    fileRecordRepository,
    fileSystemAdapter,
    loadEmbeddingQueue,
    setIsImporting,
    setSyncStatus,
    validateHostedProviderAccess,
    validateLocalRuntime,
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
          lastError: loadEmbeddingQueue
            ? 'Background indexing runtime is unavailable.'
            : 'Embedding queue loader is unavailable.',
        });
      } else {
        resetSyncStatus();
      }
      return;
    }

    void service.sync({
      enabled,
      managedCollectionId,
      rootDirectoryHandle,
    });
  }, [
    enabled,
    loadEmbeddingQueue,
    managedCollectionId,
    resetSyncStatus,
    rootDirectoryHandle,
    service,
    setSyncStatus,
  ]);

  useEffect(() => {
    triggerSync();
    return () => {
      service?.cancel();
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
