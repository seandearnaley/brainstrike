import { describe, expect, it } from 'vitest';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
} from '../stores/workspace-collection-sync-status-helpers';

describe('workspace collection sync status helpers', () => {
  it('builds metric rows for each populated sync phase', () => {
    expect(
      getWorkspaceCollectionSyncMetricRows({
        scanSummary: {
          changedFiles: 2,
          discoveredFiles: 10,
          excludedEntries: 3,
          unchangedFiles: 8,
        },
        importProgress: {
          completed: 2,
          current: '/workspace/src/a.ts',
          errorCount: 1,
          total: 4,
        },
        chunkingProgress: {
          chunksCreated: 18,
          currentFile: '/workspace/src/a.ts',
          filesProcessed: 3,
          strategyUsed: 'batched-worker',
          totalFiles: 4,
        },
        embeddingProgress: {
          chunksProcessed: 12,
          currentChunk: 'chunk-12',
          modelName: 'all-MiniLM-L6-v2',
          totalChunks: 18,
        },
        queueProgress: {
          failed: 1,
          lastError: null,
          lastEvent: null,
          pending: 2,
          processed: 8,
          totalQueued: 11,
        },
      })
    ).toEqual([
      {
        label: 'Scan',
        value: '10 eligible • 8 unchanged • 2 to update • 3 excluded entries',
      },
      {
        label: 'Import files',
        value: '2/4 files • 1 error',
      },
      {
        label: 'Chunking',
        value: '3/4 files • 18 chunks • batched-worker',
      },
      {
        label: 'Embedded',
        value: '12/18 chunks • all-MiniLM-L6-v2',
      },
      {
        label: 'Queue',
        value: '8/11 done • 2 pending • 1 failed',
      },
    ]);
  });

  it('omits metric rows when the corresponding phase has no useful data', () => {
    expect(
      getWorkspaceCollectionSyncMetricRows({
        scanSummary: null,
        importProgress: {
          completed: 0,
          current: null,
          errorCount: 0,
          total: 0,
        },
        chunkingProgress: {
          chunksCreated: 0,
          currentFile: null,
          filesProcessed: 0,
          strategyUsed: null,
          totalFiles: 0,
        },
        embeddingProgress: {
          chunksProcessed: 0,
          currentChunk: null,
          modelName: null,
          totalChunks: 0,
        },
        queueProgress: {
          failed: 0,
          lastError: null,
          lastEvent: null,
          pending: 0,
          processed: 0,
          totalQueued: 0,
        },
      })
    ).toEqual([]);
  });

  it('returns the right current-activity label for each sync state', () => {
    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'recovering',
        currentFilePath: '/workspace/src/fallback.ts',
        pauseReasons: [],
        importProgress: null,
        chunkingProgress: null,
        embeddingProgress: {
          chunksProcessed: 3,
          currentChunk: 'chunk-3',
          modelName: null,
          totalChunks: 9,
        },
      })
    ).toEqual({ label: 'Reattaching backfill', value: 'chunk-3' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'scanning',
        currentFilePath: '/workspace/src/scan.ts',
        pauseReasons: [],
        importProgress: null,
        chunkingProgress: null,
        embeddingProgress: null,
      })
    ).toEqual({ label: 'Scanning', value: '/workspace/src/scan.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'importing',
        currentFilePath: '/workspace/src/import.ts',
        pauseReasons: [],
        importProgress: {
          completed: 1,
          current: '/workspace/src/current-import.ts',
          errorCount: 0,
          total: 4,
        },
        chunkingProgress: null,
        embeddingProgress: null,
      })
    ).toEqual({ label: 'Importing file', value: '/workspace/src/current-import.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'chunking',
        currentFilePath: '/workspace/src/chunk.ts',
        pauseReasons: [],
        importProgress: null,
        chunkingProgress: {
          chunksCreated: 4,
          currentFile: '/workspace/src/current-chunk.ts',
          filesProcessed: 1,
          strategyUsed: null,
          totalFiles: 2,
        },
        embeddingProgress: null,
      })
    ).toEqual({ label: 'Chunking file', value: '/workspace/src/current-chunk.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'embedding',
        currentFilePath: '/workspace/src/embed.ts',
        pauseReasons: [],
        importProgress: null,
        chunkingProgress: null,
        embeddingProgress: {
          chunksProcessed: 4,
          currentChunk: 'chunk-4',
          modelName: null,
          totalChunks: 10,
        },
      })
    ).toEqual({ label: 'Embedding chunk', value: 'chunk-4' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'paused',
        currentFilePath: null,
        pauseReasons: ['Paused for local assistant'],
        importProgress: null,
        chunkingProgress: null,
        embeddingProgress: null,
      })
    ).toEqual({ label: 'Paused by', value: 'Paused for local assistant' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        state: 'idle',
        currentFilePath: null,
        pauseReasons: [],
        importProgress: null,
        chunkingProgress: null,
        embeddingProgress: null,
      })
    ).toBeNull();
  });
});
