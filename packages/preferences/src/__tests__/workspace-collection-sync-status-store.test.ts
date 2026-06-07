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
      state: 'disabled',
      managedCollectionId: null,
      managedCollectionName: null,
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
      activeRootPath: null,
    });
  });

  it('applies status patches without dropping prior fields', () => {
    const store = useWorkspaceCollectionSyncStatusStore.getState();

    store.setStatus({
      state: 'scanning',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      activeRootPath: '/workspace/a',
      scanSummary: {
        discoveredFiles: 42,
        changedFiles: 7,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      queuedFiles: 12,
      currentFilePath: 'src/index.ts',
    });

    store.setStatus({
      state: 'recovering',
      backfillRequestId: 'background-indexing-backfill:test',
      processedFiles: 4,
      pauseReasons: [],
      chunkingProgress: {
        filesProcessed: 7,
        totalFiles: 7,
        currentFile: 'src/index.ts',
        chunksCreated: 16,
        strategyUsed: 'sentence',
      },
      embeddingProgress: {
        chunksProcessed: 4,
        totalChunks: 16,
        currentChunk: 'export const value = 1;...',
        modelName: 'Xenova/all-MiniLM-L6-v2',
      },
    });

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      state: 'recovering',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      backfillRequestId: 'background-indexing-backfill:test',
      activeRootPath: '/workspace/a',
      scanSummary: {
        discoveredFiles: 42,
        changedFiles: 7,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      queuedFiles: 12,
      processedFiles: 4,
      currentFilePath: 'src/index.ts',
      pauseReasons: [],
      chunkingProgress: {
        filesProcessed: 7,
        totalFiles: 7,
        currentFile: 'src/index.ts',
        chunksCreated: 16,
        strategyUsed: 'sentence',
      },
      embeddingProgress: {
        chunksProcessed: 4,
        totalChunks: 16,
        currentChunk: 'export const value = 1;...',
        modelName: 'Xenova/all-MiniLM-L6-v2',
      },
    });
  });

  it('clears transient progress while preserving disabled baseline on reset', () => {
    useWorkspaceCollectionSyncStatusStore.setState({
      state: 'error',
      managedCollectionId: 'set-1',
      managedCollectionName: 'Managed Cache',
      currentFilePath: 'src/index.ts',
      scanSummary: {
        discoveredFiles: 42,
        changedFiles: 7,
        excludedEntries: 5,
        unchangedFiles: 35,
      },
      importProgress: {
        completed: 7,
        total: 7,
        current: null,
        errorCount: 0,
      },
      queuedFiles: 99,
      processedFiles: 2,
      lastError: 'boom',
      pauseReasons: ['Paused manually'],
      activeRootPath: '/workspace/a',
    });

    useWorkspaceCollectionSyncStatusStore.getState().reset();

    expect(useWorkspaceCollectionSyncStatusStore.getState()).toMatchObject({
      state: 'disabled',
      managedCollectionId: null,
      managedCollectionName: null,
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
      activeRootPath: null,
    });
  });
});
