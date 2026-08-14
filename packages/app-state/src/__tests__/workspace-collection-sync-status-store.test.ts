import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/logging';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '../stores/workspace-collection-sync-status-store';

describe('workspace-collection-sync-status-store', () => {
  beforeEach(() => {
    __resetWorkspaceCollectionSyncStatusStoreForTests();
  });

  describe('durable error-state logging (BST-1257)', () => {
    let captured: LogRecord[] = [];
    let removeListener: (() => void) | null = null;

    beforeEach(() => {
      setLogLevel(LogLevel.INFO);
      captured = [];
      removeListener = addLogListener((record) => {
        if (record.scope === 'WorkspaceCollectionSyncStatus') {
          captured.push(record);
        }
      });
    });

    afterEach(() => {
      removeListener?.();
      removeListener = null;
    });

    it('logs an error-level record when a sync error surfaces, deduped until it changes', () => {
      const store = useWorkspaceCollectionSyncStatusStore.getState();
      const errorPatch = {
        activeRootPath: '/workspace/a',
        lastError: "AccessError: Path validation failed for '/workspace/a/.nyc_output'",
        managedCollectionId: 'col-1',
        state: 'error' as const,
      };

      store.setStatus(errorPatch);
      store.setStatus(errorPatch);

      expect(captured).toHaveLength(1);
      expect(captured[0]?.level).toBe(LogLevel.ERROR);
      expect(captured[0]?.args[1]).toMatchObject({
        activeRootPath: '/workspace/a',
        lastError: errorPatch.lastError,
        managedCollectionId: 'col-1',
        state: 'error',
      });

      store.setStatus({ ...errorPatch, lastError: 'a different failure' });

      expect(captured).toHaveLength(2);
    });

    it('logs blocked states at warn level with the blocked reason', () => {
      const store = useWorkspaceCollectionSyncStatusStore.getState();

      store.setStatus({
        blockedReason: 'missing-provider-key',
        lastError: 'Embedding provider key is missing.',
        state: 'blocked',
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.level).toBe(LogLevel.WARN);
      expect(captured[0]?.args[1]).toMatchObject({
        blockedReason: 'missing-provider-key',
        state: 'blocked',
      });
    });

    it('does not log when an error clears', () => {
      const store = useWorkspaceCollectionSyncStatusStore.getState();
      store.setStatus({ lastError: 'failed once', state: 'error' });
      captured = [];

      store.setStatus({ lastError: null, state: 'idle' });

      expect(captured).toHaveLength(0);
    });

    it('logs again when the same error recurs after clearing', () => {
      const store = useWorkspaceCollectionSyncStatusStore.getState();
      store.setStatus({ lastError: 'failed once', state: 'error' });
      store.setStatus({ lastError: null, state: 'idle' });
      captured = [];

      store.setStatus({ lastError: 'failed once', state: 'error' });

      expect(captured).toHaveLength(1);
    });
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
        truncatedDirectories: 0,
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
        truncatedDirectories: 0,
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
        truncatedDirectories: 0,
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
