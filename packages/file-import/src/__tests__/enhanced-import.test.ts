import { describe, expect, it, vi } from 'vitest';
import type { BaseImportRunner, EmbeddingJobQueuePort, SqlExecutorPort } from '../enhanced-import';
import { runEnhancedImport } from '../enhanced-import';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

function createBaseRunner(
  results: EnhancedImportResult[],
  progress?: { total: number; completed: number }
): BaseImportRunner {
  return async ({ onProgress }) => {
    if (progress) {
      onProgress({
        total: progress.total,
        completed: progress.completed,
        current: 'file',
        errors: [],
      });
    }
    return results.map((result) => ({
      id: result.id,
      imported: result.imported,
      existed: result.existed,
      error: result.error,
    }));
  };
}

describe('runEnhancedImport', () => {
  it('returns base results when chunking is disabled', async () => {
    const baseResults: EnhancedImportResult[] = [
      { id: '1', imported: true, existed: false, chunksCreated: 0 },
    ];
    const onProgress = vi.fn();
    let latest: EnhancedImportProgress | null = null;

    const injectedQueueProgress = {
      pending: 2,
      processed: 3,
      failed: 1,
      totalQueued: 4,
      lastError: 'temporary failure',
    } as EnhancedImportProgress['queueProgress'];

    const results = await runEnhancedImport({
      request: {
        selectedFilePaths: new Set(['1']),
        fileTree: [],
        fileContents: {},
      },
      baseImportRunner: createBaseRunner(baseResults, { total: 1, completed: 1 }),
      chunking: {
        enabled: false,
        deps: { repository: {} as never, chunkRepository: {} as never },
      },
      progressHandlers: {
        emit: onProgress,
        update: (updater) => {
          latest = updater(latest);
          if (latest && !latest.queueProgress) {
            latest = {
              ...latest,
              queueProgress: injectedQueueProgress,
            };
          }
        },
      },
    });

    expect(results).toEqual([{ id: '1', imported: true, existed: false, chunksCreated: 0 }]);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'importing', total: 1, completed: 1 })
    );
    expect(latest).toEqual(
      expect.objectContaining({
        phase: 'complete',
        total: 1,
        completed: 1,
        queueProgress: injectedQueueProgress,
      })
    );
  });

  it('passes queue ports through to chunking implementation', async () => {
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 2,
      } satisfies EnhancedImportResult,
    ]);
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };

    const results = await runEnhancedImport({
      request: {
        selectedFilePaths: new Set(['1']),
        fileTree: [],
        fileContents: {},
      },
      baseImportRunner: createBaseRunner([
        { id: '1', imported: true, existed: false, chunksCreated: 2 },
      ]),
      chunking: {
        enabled: true,
        deps: { repository: {} as never, chunkRepository: {} as never },
      },
      ports: { embeddingQueue: queuePort },
      embedding: {
        enabled: true,
        model: 'mock-model',
        service: {} as never,
        chunkRepository: {} as never,
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
    });

    expect(chunkingImpl).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        repository: expect.anything(),
        chunkRepository: expect.anything(),
      }),
      expect.objectContaining({ embedQueueEnabled: true })
    );
    const options = chunkingImpl.mock.calls[0]?.[2];
    await options?.enqueueJobsForChunks?.(
      [
        {
          id: 'chunk-1',
          fileRecordId: '1',
          content: 'example',
          contentHash: 'hash',
        } as never,
      ],
      '1'
    );
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        model: 'mock-model',
        targetEmbeddingSetId: null,
      })
    );
    expect(results[0]?.chunksCreated).toBe(2);
  });

  it('resolves embedding model via SQL port when available', async () => {
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.processEmbeddings?.(
        [
          {
            id: 'chunk-1',
            content: 'hello',
          } as never,
        ],
        {
          id: '1',
          imported: true,
          existed: false,
          chunksCreated: 1,
        }
      );
      return [
        {
          id: '1',
          imported: true,
          existed: false,
          chunksCreated: 1,
        } satisfies EnhancedImportResult,
      ];
    });
    const embeddingsImpl = vi.fn().mockResolvedValue(undefined);
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({ rows: [{ modelKey: 'db-model' }] }),
      runInTransaction: vi.fn(),
    };

    await runEnhancedImport({
      request: {
        selectedFilePaths: new Set(['1']),
        fileTree: [],
        fileContents: {},
      },
      baseImportRunner: createBaseRunner([
        { id: '1', imported: true, existed: false, chunksCreated: 1 },
      ]),
      chunking: {
        enabled: true,
        deps: { repository: {} as never, chunkRepository: {} as never },
      },
      embedding: {
        enabled: true,
        model: undefined,
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'set-1',
      },
      ports: { sql: sqlPort },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
      processEmbeddingsImpl: embeddingsImpl,
    });

    expect(sqlPort.query).toHaveBeenCalledWith(
      'SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1 LIMIT 1',
      ['set-1']
    );
    expect(embeddingsImpl).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ id: '1' }),
      {} as never,
      {} as never,
      'db-model',
      expect.any(Function),
      'set-1'
    );
  });
});
