import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseImportRunner,
  BaseImportRunnerRequest,
  EmbeddingJobQueuePort,
  SqlExecutorPort,
} from '../enhanced-import';
import { runEnhancedImport } from '../enhanced-import';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

function createBaseRunner(
  results: EnhancedImportResult[],
  progress?: { total: number; completed: number }
): BaseImportRunner<unknown> {
  return async (request: BaseImportRunnerRequest<unknown>) => {
    if (progress) {
      request.onProgress({
        total: progress.total,
        completed: progress.completed,
        current: 'file',
        errors: [],
      });
    }
    return results.map((result) => {
      const baseResult: { id: string; imported: boolean; existed: boolean; error?: string } = {
        id: result.id,
        imported: result.imported,
        existed: result.existed,
      };
      if (result.error !== undefined) {
        baseResult.error = result.error;
      }
      return baseResult;
    });
  };
}

describe('runEnhancedImport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns base results when chunking is disabled', async () => {
    const baseResults: EnhancedImportResult[] = [
      { id: '1', imported: true, existed: false, chunksCreated: 0 },
    ];
    const onProgress = vi.fn();
    let latest: EnhancedImportProgress | null = null;

    const injectedQueueProgress: NonNullable<EnhancedImportProgress['queueProgress']> = {
      pending: 2,
      processed: 3,
      failed: 1,
      totalQueued: 4,
      lastError: 'temporary failure',
    };

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

  it('throws error when preferred set model key differs (no auto-creation)', async () => {
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
      } satisfies EnhancedImportResult,
    ]);
    const embeddingsImpl = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(SimpleEmbeddingService, 'getModelConfig').mockReturnValue({
      id: 'db-model',
      name: 'DB Model',
      dimensions: 768,
      quantized: false,
      description: 'Test model',
      tags: [],
      origin: 'test',
      size: 'test',
    });

    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'legacy-model' }] });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.resolve({
          rows: [
            {
              id: 'legacy-set',
              modelKey: 'legacy-model',
              dimensions: 768,
              distance: 'cosine',
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO embedding_sets')) {
        return Promise.resolve({ rows: [{ id: 'new-set' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const sqlPort: SqlExecutorPort = {
      query: sqlPortQuery,
      runInTransaction: vi.fn(),
    };

    const resolvedSetIdSpy = vi.fn();

    await expect(
      runEnhancedImport({
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
          model: 'db-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'legacy-set',
          onResolvedTargetSetId: resolvedSetIdSpy,
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        processChunkingImpl: chunkingImpl,
        processEmbeddingsImpl: embeddingsImpl,
      })
    ).rejects.toThrow('No search collection selected');
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
        resolveTargetEmbeddingSetId: () => 'set-1',
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
    expect(options?.tokenTrueSizing).toBe(true);
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
        model: 'local::mock-model',
        targetEmbeddingSetId: 'set-1',
        targetDimension: 768,
        provider: 'local',
        dimensionParameter: null,
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

    // Mock SQL responses for embedding set queries
    const sqlMockResponses: Record<string, () => Promise<{ rows: unknown[] }>> = {
      'SELECT model_key': () => Promise.resolve({ rows: [{ modelKey: 'local::db-model' }] }),
      'SELECT id, model_key': () =>
        Promise.resolve({
          rows: [{ id: 'set-1', modelKey: 'local::db-model', dimensions: 768, distance: 'cosine' }],
        }),
      'FROM embedding_sets s': () =>
        Promise.resolve({ rows: [{ id: 'set-1', modelKey: 'local::db-model' }] }),
      'INSERT INTO embedding_sets': () => Promise.resolve({ rows: [{ id: 'set-1' }] }),
      'UPDATE embedding_sets': () => Promise.resolve({ rows: [] }),
    };

    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      for (const [key, handler] of Object.entries(sqlMockResponses)) {
        if (sql.includes(key)) {
          return handler();
        }
      }
      return Promise.resolve({ rows: [] });
    });
    const sqlPort: SqlExecutorPort = {
      query: sqlPortQuery,
      runInTransaction: vi.fn(),
    };

    const resolvedSetIdSpy = vi.fn();

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
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'set-1',
        onResolvedTargetSetId: resolvedSetIdSpy,
      },
      ports: { sql: sqlPort },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
      processEmbeddingsImpl: embeddingsImpl,
    });

    // Verify SQL port is used to query embedding sets
    expect(sqlPortQuery).toHaveBeenCalled();
    // Verify that a model key lookup query was made
    const calls = sqlPortQuery.mock.calls as Array<[string, unknown[]?]>;
    const lookupCall = calls.find(([statement]) => {
      return (
        typeof statement === 'string' &&
        statement.includes('model_key IN') &&
        statement.includes('embedding_sets')
      );
    });
    expect(lookupCall).toBeDefined();
    // Verify embeddings implementation was called with expected parameters
    expect(embeddingsImpl).toHaveBeenCalled();
    expect(resolvedSetIdSpy).toHaveBeenCalledWith('set-1');
  });

  it('does NOT create embedding set when embeddings are disabled', async () => {
    vi.spyOn(SimpleEmbeddingService, 'getModelConfig').mockReturnValue({
      id: 'db-model',
      name: 'DB Model',
      dimensions: 768,
      quantized: false,
      description: 'Test model',
      tags: [],
      origin: 'test',
      size: 'test',
    });

    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO embedding_sets')) {
        return Promise.resolve({ rows: [{ id: 'new-set' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const sqlPort: SqlExecutorPort = {
      query: sqlPortQuery,
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
        enabled: false,
        model: 'local::db-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => null,
      },
      ports: { sql: sqlPort },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: vi
        .fn()
        .mockResolvedValue([{ id: '1', imported: true, existed: false, chunksCreated: 1 }]),
    });

    // When embeddings are disabled, should NOT create embedding set
    expect(
      sqlPortQuery.mock.calls.some(
        ([statement]) =>
          typeof statement === 'string' && statement.startsWith('INSERT INTO embedding_sets')
      )
    ).toBe(false);
  });
});
