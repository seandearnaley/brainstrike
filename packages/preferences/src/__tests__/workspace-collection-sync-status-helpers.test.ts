import { describe, expect, it } from 'vitest';
import {
  getWorkspaceCollectionSyncCurrentActivity,
  getWorkspaceCollectionSyncMetricRows,
} from '../stores/workspace-collection-sync-status-helpers';

describe('workspace collection sync status helpers', () => {
  it('builds metric rows for each populated sync phase', () => {
    expect(
      getWorkspaceCollectionSyncMetricRows({
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
        importProgress: {
          completed: 2,
          current: '/workspace/src/a.ts',
          errorCount: 1,
          total: 4,
        },
        queueProgress: {
          failed: 1,
          lastError: null,
          lastEvent: null,
          pending: 2,
          processed: 8,
          totalQueued: 11,
        },
        scanSummary: {
          changedFiles: 2,
          discoveredFiles: 10,
          excludedEntries: 3,
          unchangedFiles: 8,
        },
        unindexableFileCount: 2,
      })
    ).toEqual([
      {
        label: 'Scan',
        value: '10 eligible • 8 unchanged • 2 to update • 3 excluded entries',
      },
      {
        label: 'Coverage',
        value: '2 files skipped — content cannot be indexed (binary or unreadable)',
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
        importProgress: {
          completed: 0,
          current: null,
          errorCount: 0,
          total: 0,
        },
        queueProgress: {
          failed: 0,
          lastError: null,
          lastEvent: null,
          pending: 0,
          processed: 0,
          totalQueued: 0,
        },
        scanSummary: null,
        unindexableFileCount: 0,
      })
    ).toEqual([]);
  });

  it('omits the coverage row when the unindexable count is unknown', () => {
    expect(
      getWorkspaceCollectionSyncMetricRows({
        chunkingProgress: null,
        embeddingProgress: null,
        importProgress: null,
        queueProgress: null,
        scanSummary: null,
        unindexableFileCount: null,
      })
    ).toEqual([]);
  });

  it('uses singular phrasing for one unindexable file', () => {
    expect(
      getWorkspaceCollectionSyncMetricRows({
        chunkingProgress: null,
        embeddingProgress: null,
        importProgress: null,
        queueProgress: null,
        scanSummary: null,
        unindexableFileCount: 1,
      })
    ).toEqual([
      {
        label: 'Coverage',
        value: '1 file skipped — content cannot be indexed (binary or unreadable)',
      },
    ]);
  });

  it('returns the right current-activity label for each sync state', () => {
    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: '/workspace/src/fallback.ts',
        embeddingProgress: {
          chunksProcessed: 3,
          currentChunk: 'chunk-3',
          modelName: null,
          totalChunks: 9,
        },
        importProgress: null,
        pauseReasons: [],
        state: 'recovering',
      })
    ).toEqual({ label: 'Reattaching backfill', value: 'chunk-3' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: '/workspace/src/scan.ts',
        embeddingProgress: null,
        importProgress: null,
        pauseReasons: [],
        state: 'scanning',
      })
    ).toEqual({ label: 'Scanning', value: '/workspace/src/scan.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: '/workspace/src/import.ts',
        embeddingProgress: null,
        importProgress: {
          completed: 1,
          current: '/workspace/src/current-import.ts',
          errorCount: 0,
          total: 4,
        },
        pauseReasons: [],
        state: 'importing',
      })
    ).toEqual({ label: 'Importing file', value: '/workspace/src/current-import.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: {
          chunksCreated: 4,
          currentFile: '/workspace/src/current-chunk.ts',
          filesProcessed: 1,
          strategyUsed: null,
          totalFiles: 2,
        },
        currentFilePath: '/workspace/src/chunk.ts',
        embeddingProgress: null,
        importProgress: null,
        pauseReasons: [],
        state: 'chunking',
      })
    ).toEqual({ label: 'Chunking file', value: '/workspace/src/current-chunk.ts' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: '/workspace/src/embed.ts',
        embeddingProgress: {
          chunksProcessed: 4,
          currentChunk: 'chunk-4',
          modelName: null,
          totalChunks: 10,
        },
        importProgress: null,
        pauseReasons: [],
        state: 'embedding',
      })
    ).toEqual({ label: 'Embedding chunk', value: 'chunk-4' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: null,
        embeddingProgress: null,
        importProgress: null,
        pauseReasons: ['Paused for local assistant'],
        state: 'paused',
      })
    ).toEqual({ label: 'Paused by', value: 'Paused for local assistant' });

    expect(
      getWorkspaceCollectionSyncCurrentActivity({
        chunkingProgress: null,
        currentFilePath: null,
        embeddingProgress: null,
        importProgress: null,
        pauseReasons: [],
        state: 'idle',
      })
    ).toBeNull();
  });
});
