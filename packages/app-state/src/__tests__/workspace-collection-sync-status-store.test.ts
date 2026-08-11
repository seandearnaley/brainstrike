import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '../stores/workspace-collection-sync-status-store';

describe('workspace-collection-sync-status-store', () => {
  beforeEach(() => {
    __resetWorkspaceCollectionSyncStatusStoreForTests();
  });

  it('initializes with disabled status and no active root', () => {
    const state = useWorkspaceCollectionSyncStatusStore.getState();

    expect(state).toMatchObject({
      activeRootPath: null,
      backfillRequestId: null,
      blockedReason: null,
      chunkingProgress: null,
      currentFilePath: null,
      embeddingProgress: null,
      importProgress: null,
      lastError: null,
      managedCollectionId: null,
      managedCollectionName: null,
      pauseReasons: [],
      processedFiles: 0,
      queuedFiles: 0,
      queueProgress: null,
      scanSummary: null,
      state: 'disabled',
    });
  });

  it('applies status patches without dropping prior fields', () => {
    const store = useWorkspaceCollectionSyncStatusStore.getState();

    store.setStatus({
      activeRootPath: '/workspace/a',
      currentFilePath: 'src/index.ts',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      queuedFiles: 12,
      scanSummary: {
        changedFiles: 7,
        discoveredFiles: 42,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      state: 'scanning',
    });

    store.setStatus({
      backfillRequestId: 'background-indexing-backfill:test',
      chunkingProgress: {
        chunksCreated: 16,
        currentFile: 'src/index.ts',
        filesProcessed: 7,
        strategyUsed: 'sentence',
        totalFiles: 7,
      },
      embeddingProgress: {
        chunksProcessed: 4,
        currentChunk: 'export const value = 1;...',
        modelName: 'Xenova/all-MiniLM-L6-v2',
        totalChunks: 16,
      },
      pauseReasons: [],
      processedFiles: 4,
      state: 'recovering',
    });

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      activeRootPath: '/workspace/a',
      backfillRequestId: 'background-indexing-backfill:test',
      chunkingProgress: {
        chunksCreated: 16,
        currentFile: 'src/index.ts',
        filesProcessed: 7,
        strategyUsed: 'sentence',
        totalFiles: 7,
      },
      currentFilePath: 'src/index.ts',
      embeddingProgress: {
        chunksProcessed: 4,
        currentChunk: 'export const value = 1;...',
        modelName: 'Xenova/all-MiniLM-L6-v2',
        totalChunks: 16,
      },
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      pauseReasons: [],
      processedFiles: 4,
      queuedFiles: 12,
      scanSummary: {
        changedFiles: 7,
        discoveredFiles: 42,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      state: 'recovering',
    });
  });

  it('clears transient progress while preserving disabled baseline on reset', () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      activeRootPath: '/workspace/a',
      currentFilePath: 'src/index.ts',
      importProgress: {
        completed: 7,
        current: null,
        errorCount: 0,
        total: 7,
      },
      lastError: 'boom',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      pauseReasons: ['Paused manually'],
      processedFiles: 2,
      queuedFiles: 99,
      scanSummary: {
        changedFiles: 7,
        discoveredFiles: 42,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      state: 'error',
    });

    useWorkspaceCollectionSyncStatusStore.getState().reset();

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      activeRootPath: null,
      backfillRequestId: null,
      blockedReason: null,
      chunkingProgress: null,
      currentFilePath: null,
      embeddingProgress: null,
      importProgress: null,
      lastError: null,
      managedCollectionId: null,
      managedCollectionName: null,
      pauseReasons: [],
      processedFiles: 0,
      queuedFiles: 0,
      queueProgress: null,
      scanSummary: null,
      state: 'disabled',
    });
  });
});
