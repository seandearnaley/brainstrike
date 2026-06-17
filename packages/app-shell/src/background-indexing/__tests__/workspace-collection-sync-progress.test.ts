import type { EnhancedImportProgress } from '@brainstrike/file-import';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBatchImportErrors,
  buildNormalizedChunkingProgress,
  createScanningStatusReporter,
  dispatchQueueDrainedEvent,
  isAbortError,
  mapBackfillProgressToStatus,
  mapEnhancedProgressToStatus,
  throwIfAborted,
  waitForAbortableDelay,
} from '../workspace-collection-sync-progress';
import { createCollection } from './workspace-collection-sync-service-test-helpers';

const scanSummary = {
  changedFiles: 3,
  discoveredFiles: 8,
  excludedEntries: 1,
  unchangedFiles: 4,
};

function createEnhancedProgress(
  overrides: Partial<EnhancedImportProgress> = {}
): EnhancedImportProgress {
  return {
    completed: 2,
    current: 'src/current.ts',
    errors: [],
    phase: 'importing',
    total: 5,
    ...overrides,
  };
}

function createEnhancedProgressWithoutCurrent(
  overrides: Partial<EnhancedImportProgress> = {}
): EnhancedImportProgress {
  const { current, ...progress } = createEnhancedProgress(overrides);
  void current;
  return progress;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('workspace collection sync progress helpers', () => {
  it('reports scans immediately, throttles pending paths, flushes, and disposes queued work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const emit = vi.fn();
    const reporter = createScanningStatusReporter(emit, 100);

    reporter.report('/workspace/a.ts');
    expect(emit).toHaveBeenCalledWith('/workspace/a.ts');

    vi.setSystemTime(1050);
    reporter.report('/workspace/b.ts');
    reporter.report('/workspace/c.ts');
    expect(emit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(emit).toHaveBeenLastCalledWith('/workspace/c.ts');

    reporter.report('/workspace/d.ts');
    reporter.flush();
    expect(emit).toHaveBeenLastCalledWith('/workspace/d.ts');

    reporter.report('/workspace/e.ts');
    reporter.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(emit).not.toHaveBeenCalledWith('/workspace/e.ts');
  });

  it('throws and detects abort errors while cleaning up abortable delays', async () => {
    vi.useFakeTimers();
    const completedController = new AbortController();
    const completedDelay = waitForAbortableDelay(25, completedController.signal);
    await vi.advanceTimersByTimeAsync(25);
    await expect(completedDelay).resolves.toBeUndefined();

    const abortedController = new AbortController();
    const abortedDelay = waitForAbortableDelay(1000, abortedController.signal);
    abortedController.abort();
    await expect(abortedDelay).rejects.toMatchObject({
      message: 'Workspace collection sync was cancelled.',
      name: 'AbortError',
    });

    expect(isAbortError(new DOMException('cancelled', 'AbortError'))).toBe(true);
    expect(() => throwIfAborted(abortedController.signal, 'Stopped by test')).toThrow(
      'Stopped by test'
    );
  });

  it('maps enhanced import progress phases into status patches', () => {
    const completeProgress = createEnhancedProgressWithoutCurrent({
      completed: 5,
      errors: [{ file: 'src/a.ts', error: 'read failed' }],
      phase: 'complete',
      total: 5,
    });
    const completeStatus = mapEnhancedProgressToStatus(
      completeProgress,
      'set-1',
      null,
      '/workspace',
      scanSummary
    );
    expect(completeStatus).toMatchObject({
      currentFilePath: null,
      lastError: 'read failed',
      managedCollectionName: null,
      processedFiles: 5,
      queuedFiles: 0,
      state: 'idle',
    });

    const embeddingStatus = mapEnhancedProgressToStatus(
      createEnhancedProgress({
        completed: 4,
        embeddingProgress: {
          chunksProcessed: 7,
          modelName: 'model-a',
          totalChunks: 10,
        },
        phase: 'embedding',
        queueProgress: {
          failed: 1,
          lastError: 'bad chunk',
          pending: 3,
          processed: 7,
          totalQueued: 11,
        },
      }),
      'set-1',
      'Workspace',
      '/workspace',
      scanSummary
    );
    expect(embeddingStatus).toMatchObject({
      currentFilePath: 'src/current.ts',
      embeddingProgress: {
        chunksProcessed: 7,
        currentChunk: null,
        modelName: 'model-a',
      },
      queueProgress: {
        failed: 1,
        lastEvent: null,
        pending: 3,
      },
      queuedFiles: 3,
      state: 'embedding',
    });

    const chunkingProgress = createEnhancedProgressWithoutCurrent({
      chunkingProgress: {
        chunksCreated: 12,
        filesProcessed: 2,
        totalFiles: 5,
      },
      phase: 'chunking',
    });
    const chunkingStatus = mapEnhancedProgressToStatus(
      chunkingProgress,
      'set-1',
      'Workspace',
      '/workspace',
      scanSummary
    );
    expect(chunkingStatus).toMatchObject({
      chunkingProgress: {
        chunksCreated: 12,
        currentFile: null,
        filesProcessed: 2,
        strategyUsed: null,
      },
      currentFilePath: null,
      processedFiles: 2,
      queuedFiles: 0,
      state: 'chunking',
    });

    const importingProgress = createEnhancedProgressWithoutCurrent({ completed: 9, total: 4 });
    const importingStatus = mapEnhancedProgressToStatus(
      importingProgress,
      'set-1',
      'Workspace',
      '/workspace',
      scanSummary
    );
    expect(importingStatus).toMatchObject({
      currentFilePath: null,
      importProgress: {
        completed: 9,
        current: null,
        errorCount: 0,
        total: 4,
      },
      queuedFiles: 0,
      state: 'importing',
    });
  });

  it('clamps backfill progress and includes scan-derived import status when available', () => {
    const recoveringStatus = mapBackfillProgressToStatus({
      chunkingProgress: null,
      collection: createCollection({
        id: 'set-1',
        modelId: 'text-embedding-3-large',
      }),
      current: 9,
      managedCollectionName: 'Workspace',
      message: '   ',
      rootPath: '/workspace',
      scanSummary,
      state: 'recovering',
      total: 4,
    });

    expect(recoveringStatus).toMatchObject({
      backfillRequestId: null,
      currentFilePath: null,
      embeddingProgress: {
        chunksProcessed: 4,
        currentChunk: null,
        modelName: 'text-embedding-3-large',
        totalChunks: 4,
      },
      importProgress: {
        completed: 3,
        current: null,
        errorCount: 0,
        total: 3,
      },
      processedFiles: 8,
      queuedFiles: 0,
      state: 'recovering',
    });

    const defaultStatus = mapBackfillProgressToStatus({
      chunkingProgress: {
        chunksCreated: 2,
        currentFile: 'src/a.ts',
        filesProcessed: 1,
        strategyUsed: 'markdown',
        totalFiles: 3,
      },
      collection: createCollection(),
      current: -5,
      managedCollectionName: null,
      message: 'Embedding src/a.ts',
      requestId: 'backfill-1',
      rootPath: '/workspace',
      total: -1,
    });

    expect(defaultStatus).toMatchObject({
      backfillRequestId: 'backfill-1',
      currentFilePath: 'Embedding src/a.ts',
      embeddingProgress: {
        chunksProcessed: 0,
        totalChunks: 0,
      },
      queueProgress: {
        pending: 0,
        processed: 0,
        totalQueued: 0,
      },
      queuedFiles: 0,
      state: 'embedding',
    });
  });

  it('normalizes chunking progress, fills synthetic batch errors, and reports queue drain events', () => {
    expect(
      buildNormalizedChunkingProgress({
        batchChunking: {
          chunksCreated: 3,
          currentFile: 'src/batch.ts',
          filesProcessed: 2,
          totalFiles: 2,
        },
        cumulativeChunksCreated: 5,
        cumulativeFilesChunked: 7,
        latestChunkingProgress: null,
        latestStrategyUsed: 'semantic-markdown',
        totalFiles: 10,
      })
    ).toEqual({
      chunksCreated: 8,
      currentFile: 'src/batch.ts',
      filesProcessed: 9,
      strategyUsed: 'semantic-markdown',
      totalFiles: 10,
    });

    expect(
      buildNormalizedChunkingProgress({
        batchChunking: undefined,
        cumulativeChunksCreated: 11,
        cumulativeFilesChunked: 4,
        latestChunkingProgress: {
          chunksCreated: 3,
          currentFile: 'src/latest.ts',
          filesProcessed: 2,
          strategyUsed: 'markdown',
          totalFiles: 2,
        },
        latestStrategyUsed: 'semantic-markdown',
        totalFiles: 12,
      })
    ).toEqual({
      chunksCreated: 11,
      currentFile: 'src/latest.ts',
      filesProcessed: 4,
      strategyUsed: 'semantic-markdown',
      totalFiles: 12,
    });

    expect(
      buildNormalizedChunkingProgress({
        batchChunking: undefined,
        cumulativeChunksCreated: 0,
        cumulativeFilesChunked: 0,
        latestChunkingProgress: null,
        latestStrategyUsed: null,
        totalFiles: 0,
      })
    ).toBeUndefined();

    expect(
      buildBatchImportErrors(
        createEnhancedProgress({ errors: [{ file: 'src/a.ts', error: 'x' }] }),
        2
      )
    ).toEqual([
      { error: 'Background cache import error.', file: 'batch:0' },
      { error: 'Background cache import error.', file: 'batch:1' },
      { error: 'x', file: 'src/a.ts' },
    ]);

    const listener = vi.fn();
    const onQueueDrained = (event: Event): void => {
      listener((event as CustomEvent).detail);
    };
    window.addEventListener('brainstrike:queue-drained', onQueueDrained);
    try {
      dispatchQueueDrainedEvent('set-1');
      expect(listener).toHaveBeenCalledWith({
        embeddingSetId: 'set-1',
        queue: 'embeddings',
      });
    } finally {
      window.removeEventListener('brainstrike:queue-drained', onQueueDrained);
    }
  });
});
