import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseImportRunner,
  BaseImportRunnerRequest,
  EmbeddingJobQueuePort,
  SqlExecutorPort,
} from '../enhanced-import';
import { runEnhancedImport } from '../enhanced-import';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';

const { resolveHostedProviderApiKeyMock } = vi.hoisted(() => ({
  resolveHostedProviderApiKeyMock: vi.fn(),
}));

vi.mock('@brainstrike/embeddings', () => ({
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
}));

function createBaseRunner(
  results: EnhancedImportResult[],
  progress?: { total: number; completed: number }
): BaseImportRunner<unknown> {
  return async (request: BaseImportRunnerRequest<unknown>) => {
    if (progress) {
      request.onProgress({
        completed: progress.completed,
        current: 'file',
        errors: [],
        total: progress.total,
      });
    }
    return results.map((result) => {
      const baseResult: { id: string; imported: boolean; existed: boolean; error?: string } = {
        existed: result.existed,
        id: result.id,
        imported: result.imported,
      };
      if (result.error !== undefined) {
        baseResult.error = result.error;
      }
      return baseResult;
    });
  };
}

describe('runEnhancedImport', () => {
  beforeEach(() => {
    resolveHostedProviderApiKeyMock.mockResolvedValue('test-api-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveHostedProviderApiKeyMock.mockReset();
  });

  it('returns base results when chunking is disabled', async () => {
    const baseResults: EnhancedImportResult[] = [
      { chunksCreated: 0, existed: false, id: '1', imported: true },
    ];
    const onProgress = vi.fn();
    let latest: EnhancedImportProgress | null = null;

    const injectedQueueProgress: NonNullable<EnhancedImportProgress['queueProgress']> = {
      failed: 1,
      lastError: 'temporary failure',
      pending: 2,
      processed: 3,
      totalQueued: 4,
    };

    const results = await runEnhancedImport({
      baseImportRunner: createBaseRunner(baseResults, { completed: 1, total: 1 }),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: false,
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
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(results).toEqual([{ chunksCreated: 0, existed: false, id: '1', imported: true }]);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 1, phase: 'importing', total: 1 })
    );
    expect(latest).toEqual(
      expect.objectContaining({
        completed: 1,
        phase: 'complete',
        queueProgress: injectedQueueProgress,
        total: 1,
      })
    );
  });

  it('does not throw error when embeddings disabled (chunks still get embedding_set_id)', async () => {
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 1,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);
    const embeddingsImpl = vi.fn().mockResolvedValue(undefined);

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
              createdAt: new Date().toISOString(),
              dimensions: 768,
              distance: 'cosine',
              id: 'legacy-set',
              modelKey: 'legacy-model',
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

    const results = await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: false,
        model: 'db-model',
        onResolvedTargetSetId: resolvedSetIdSpy,
        resolveTargetEmbeddingSetId: () => 'legacy-set',
        service: {} as never,
      },
      ports: { sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      processEmbeddingsImpl: embeddingsImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    // Should succeed and chunks should be created with embedding_set_id
    expect(results).toHaveLength(1);
    expect(results[0]?.chunksCreated).toBe(1);
  });

  it('passes queue ports through to chunking implementation', async () => {
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 2,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM models')) {
          return Promise.resolve({
            rows: [
              {
                capabilities: JSON.stringify({ defaultDimension: 768, type: 'embedding' }),
                id: 'mock-model',
                providerId: 'transformers',
              },
            ],
          });
        }
        if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
          return Promise.resolve({ rows: [{ modelKey: 'local::mock-model' }] });
        }
        if (
          sql.startsWith(
            'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
          )
        ) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith('INSERT INTO embedding_sets')) {
          return Promise.resolve({ rows: [{ id: 'set-1' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      runInTransaction: vi.fn(),
    };

    const results = await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 2, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'mock-model',
        resolveTargetEmbeddingSetId: () => 'set-1',
        service: {} as never,
        targetDimension: 384,
      },
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(chunkingImpl).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        chunkRepository: expect.anything(),
        repository: expect.anything(),
      }),
      expect.objectContaining({ embedQueueEnabled: true })
    );
    const options = chunkingImpl.mock.calls[0]?.[2];
    expect(options?.tokenTrueSizing).toBe(true);
    await options?.enqueueJobsForChunks?.(
      [
        {
          content: 'example',
          contentHash: 'hash',
          fileRecordId: '1',
          id: 'chunk-1',
        } as never,
      ],
      '1'
    );
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        dimensionParameter: null,
        model: 'local::mock-model',
        provider: 'local',
        targetDimension: 384,
        targetEmbeddingSetId: 'set-1',
      })
    );
    expect(results[0]?.chunksCreated).toBe(2);
  });

  it('resolves hosted embedding metadata and queues chunks with explicit dimensions', async () => {
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({
          rows: [{ modelKey: 'openai::text-embedding-3-small' }],
        });
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO embedding_sets')) {
        return Promise.resolve({ rows: [{ id: 'hosted-set' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const sqlPort: SqlExecutorPort = {
      query: sqlPortQuery,
      runInTransaction: vi.fn(),
    };
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.enqueueJobsForChunks?.(
        [
          {
            content: 'hosted content',
            contentHash: 'hash-openai',
            fileRecordId: '1',
            id: 'chunk-openai',
          } as never,
        ],
        '1'
      );
      return [
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        } satisfies EnhancedImportResult,
      ];
    });
    const resolvedSetIdSpy = vi.fn();

    const results = await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'text-embedding-3-small',
        onResolvedTargetSetId: resolvedSetIdSpy,
        provider: 'openai',
        resolveTargetEmbeddingSetId: () => 'preferred-hosted-set',
        service: {} as never,
      },
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');
    expect(resolvedSetIdSpy).toHaveBeenCalledWith('hosted-set');
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        dimensionParameter: 'dimensions',
        model: 'openai::text-embedding-3-small',
        provider: 'openai',
        targetDimension: 768,
        targetEmbeddingSetId: 'hosted-set',
      })
    );
    expect(results[0]?.chunksCreated).toBe(1);
  });

  it('uses the preferred hosted target set without SQL and dispatches an update event', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 1,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);
    const resolvedSetIdSpy = vi.fn();

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'text-embedding-3-small',
        onResolvedTargetSetId: resolvedSetIdSpy,
        provider: 'openai',
        resolveTargetEmbeddingSetId: () => 'preferred-hosted-set',
        service: {} as never,
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolvedSetIdSpy).toHaveBeenCalledWith('preferred-hosted-set');
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { id: 'preferred-hosted-set' },
        type: 'brainstrike:embedding-set-updated',
      })
    );
    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        targetEmbeddingSetId: 'preferred-hosted-set',
      })
    );
  });

  it('uses fixed hosted model dimensions when the provider model does not support standard dimensions', async () => {
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
          return Promise.resolve({ rows: [{ modelKey: 'voyage::voyage-3-lite' }] });
        }
        if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith('INSERT INTO embedding_sets')) {
          return Promise.resolve({ rows: [{ id: 'voyage-set' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      runInTransaction: vi.fn(),
    };
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.enqueueJobsForChunks?.(
        [
          {
            content: 'voyage content',
            contentHash: 'hash-voyage',
            fileRecordId: '1',
            id: 'chunk-voyage',
          } as never,
        ],
        '1'
      );
      return [
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        } satisfies EnhancedImportResult,
      ];
    });

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'voyage-3-lite',
        provider: 'voyage',
        resolveTargetEmbeddingSetId: () => 'preferred-voyage-set',
        service: {} as never,
      },
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('voyage');
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        dimensionParameter: null,
        provider: 'voyage',
        targetDimension: 512,
      })
    );
  });

  it('rejects hosted embedding imports when the provider API key is unavailable', async () => {
    resolveHostedProviderApiKeyMock.mockResolvedValueOnce(null);

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'text-embedding-3-small',
          provider: 'openai',
          resolveTargetEmbeddingSetId: () => null,
          service: {} as never,
        },
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({ rows: [] }),
            runInTransaction: vi.fn(),
          },
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Hosted provider "openai" requires an API key before running embeddings.');
  });

  it('rejects enabled embeddings when neither a model nor target set is available', async () => {
    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          resolveTargetEmbeddingSetId: () => null,
          service: {} as never,
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Embedding is enabled but no model key or target set was provided.');
  });

  it('rejects enabled embeddings when a target set has no resolvable model key', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      runInTransaction: vi.fn(),
    };

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          resolveTargetEmbeddingSetId: () => 'missing-set',
          service: {} as never,
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Unable to resolve embedding model for set "missing-set".');
  });

  it('rejects target-set-only embedding resolution when SQL access is missing', async () => {
    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          resolveTargetEmbeddingSetId: () => 'sql-required-set',
          service: {} as never,
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Unable to resolve embedding model for set "sql-required-set".');
  });

  it('rejects target sets with invalid persisted model keys', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({ rows: [{ modelKey: '   ' }] }),
      runInTransaction: vi.fn(),
    };

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          resolveTargetEmbeddingSetId: () => 'invalid-key-set',
          service: {} as never,
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Embedding set invalid-key-set has invalid model key "   ".');
  });

  it('rejects local embedding models whose registry capabilities are malformed', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            capabilities: '{invalid json',
            id: 'broken-model',
            providerId: 'transformers',
          },
        ],
      }),
      runInTransaction: vi.fn(),
    };

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::broken-model',
          resolveTargetEmbeddingSetId: () => 'broken-set',
          service: {} as never,
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Model "broken-model" has invalid capabilities JSON:');
  });

  it('rejects local registry rows that are not embedding models', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            capabilities: { defaultDimension: 768, type: 'chat' },
            id: 'chat-model',
            providerId: 'transformers',
          },
        ],
      }),
      runInTransaction: vi.fn(),
    };

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::chat-model',
          resolveTargetEmbeddingSetId: () => 'chat-set',
          service: {} as never,
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Model "chat-model" is not an embedding model.');
  });

  it('rejects local registry rows with invalid dimensions and invalid payloads', async () => {
    const baseParams = {
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      progressHandlers: {
        update: (updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null) =>
          updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    };

    await expect(
      runEnhancedImport({
        ...baseParams,
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::zero-dimension-model',
          resolveTargetEmbeddingSetId: () => 'zero-dimension-set',
          service: {} as never,
        },
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({
              rows: [
                {
                  capabilities: { defaultDimension: 0, type: 'embedding' },
                  id: 'zero-dimension-model',
                  providerId: 'transformers',
                },
              ],
            }),
            runInTransaction: vi.fn(),
          },
        },
      })
    ).rejects.toThrow('Model "zero-dimension-model" has invalid dimensions in registry.');

    await expect(
      runEnhancedImport({
        ...baseParams,
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::invalid-payload-model',
          resolveTargetEmbeddingSetId: () => 'invalid-payload-set',
          service: {} as never,
        },
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({
              rows: [
                {
                  capabilities: null,
                  id: 'invalid-payload-model',
                  providerId: 'transformers',
                },
              ],
            }),
            runInTransaction: vi.fn(),
          },
        },
      })
    ).rejects.toThrow('Model "invalid-payload-model" has invalid capabilities payload.');
  });

  it('resolves embedding model via SQL port when available', async () => {
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.processEmbeddings?.(
        [
          {
            content: 'hello',
            id: 'chunk-1',
          } as never,
        ],
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        }
      );
      return [
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        } satisfies EnhancedImportResult,
      ];
    });
    const embeddingsImpl = vi.fn().mockResolvedValue(undefined);

    // Mock SQL responses for embedding set queries
    const sqlMockResponses: Record<string, () => Promise<{ rows: unknown[] }>> = {
      'FROM embedding_sets s': () =>
        Promise.resolve({ rows: [{ id: 'set-2', modelKey: 'local::db-model' }] }),
      'FROM models': () =>
        Promise.resolve({
          rows: [
            {
              capabilities: JSON.stringify({ defaultDimension: 768, type: 'embedding' }),
              id: 'db-model',
              providerId: 'transformers',
            },
          ],
        }),
      'INSERT INTO embedding_sets': () => Promise.resolve({ rows: [{ id: 'set-2' }] }),
      'SELECT id, model_key': () =>
        Promise.resolve({
          rows: [{ dimensions: 768, distance: 'cosine', id: 'set-2', modelKey: 'local::db-model' }],
        }),
      'SELECT model_key': () => Promise.resolve({ rows: [{ modelKey: 'local::db-model' }] }),
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
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        onResolvedTargetSetId: resolvedSetIdSpy,
        resolveTargetEmbeddingSetId: () => 'set-2',
        service: {} as never,
      },
      ports: { sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      processEmbeddingsImpl: embeddingsImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    // Verify SQL port is used to query embedding sets
    expect(sqlPortQuery).toHaveBeenCalled();
    // Verify that a model key lookup query was made
    const calls = sqlPortQuery.mock.calls as [string, unknown[]?][];
    const lookupCall = calls.find(
      ([statement]) =>
        typeof statement === 'string' &&
        statement.includes('SELECT model_key AS "modelKey" FROM embedding_sets')
    );
    expect(lookupCall).toBeDefined();
    // Verify embeddings implementation was called with expected parameters
    expect(embeddingsImpl).toHaveBeenCalled();
    expect(resolvedSetIdSpy).toHaveBeenCalledWith('set-2');
  });

  it('creates a fresh embedding set when the preferred set metadata mismatches', async () => {
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'local::mock-model' }] });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.resolve({
          rows: [
            {
              dimensions: 384,
              distance: 'cosine',
              id: 'preferred-set',
              modelKey: 'local::different-model',
            },
          ],
        });
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO embedding_sets')) {
        return Promise.resolve({ rows: [{ id: 'fresh-set' }] });
      }
      if (sql.includes('FROM models')) {
        return Promise.resolve({
          rows: [
            {
              capabilities: { defaultDimension: 768, type: 'embedding' },
              id: 'mock-model',
              providerId: 'transformers',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const sqlPort: SqlExecutorPort = {
      query: sqlPortQuery,
      runInTransaction: vi.fn(),
    };
    const resolvedSetIdSpy = vi.fn();
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 1,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'local::mock-model',
        onResolvedTargetSetId: resolvedSetIdSpy,
        resolveTargetEmbeddingSetId: () => 'preferred-set',
        service: {} as never,
      },
      ports: { sql: sqlPort },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolvedSetIdSpy).toHaveBeenCalledWith('fresh-set');
    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ targetEmbeddingSetId: 'fresh-set' })
    );
  });

  it('creates a fresh embedding set when preferred lookup fails', async () => {
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'local::recover-model' }] });
      }
      if (sql.includes('FROM models')) {
        return Promise.resolve({
          rows: [
            {
              capabilities: { defaultDimension: 768, type: 'embedding' },
              id: 'recover-model',
              providerId: 'transformers',
            },
          ],
        });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.reject(new Error('preferred lookup failed'));
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('INSERT INTO embedding_sets')) {
        return Promise.resolve({ rows: [{ id: 'recovered-set' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const resolvedSetIdSpy = vi.fn();

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'local::recover-model',
        onResolvedTargetSetId: resolvedSetIdSpy,
        resolveTargetEmbeddingSetId: () => 'preferred-recover-set',
        service: {} as never,
      },
      ports: {
        sql: {
          query: sqlPortQuery,
          runInTransaction: vi.fn(),
        },
      },
      processChunkingImpl: vi
        .fn()
        .mockResolvedValue([{ chunksCreated: 1, existed: false, id: '1', imported: true }]),
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolvedSetIdSpy).toHaveBeenCalledWith('recovered-set');
  });

  it('surfaces matching embedding set query failures', async () => {
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'local::query-failure-model' }] });
      }
      if (sql.includes('FROM models')) {
        return Promise.resolve({
          rows: [
            {
              capabilities: { defaultDimension: 768, type: 'embedding' },
              id: 'query-failure-model',
              providerId: 'transformers',
            },
          ],
        });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.reject(new Error('matching set query failed'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::query-failure-model',
          resolveTargetEmbeddingSetId: () => 'query-failure-set',
          service: {} as never,
        },
        ports: {
          sql: {
            query: sqlPortQuery,
            runInTransaction: vi.fn(),
          },
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('matching set query failed');
  });

  it('does NOT create embedding set when embeddings are disabled', async () => {
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
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: false,
        model: 'local::db-model',
        resolveTargetEmbeddingSetId: () => null,
        service: {} as never,
      },
      ports: { sql: sqlPort },
      processChunkingImpl: vi
        .fn()
        .mockResolvedValue([{ chunksCreated: 1, existed: false, id: '1', imported: true }]),
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    // When embeddings are disabled, should NOT create embedding set
    expect(
      sqlPortQuery.mock.calls.some(
        ([statement]) =>
          typeof statement === 'string' && statement.startsWith('INSERT INTO embedding_sets')
      )
    ).toBe(false);
  });

  it('passes explicit chunking configuration and transactions into chunking options', async () => {
    const runInTransaction = vi.fn();
    const chunkingWorkerPort = {} as NonNullable<
      Parameters<typeof runEnhancedImport>[0]['chunking']['chunkingWorkerPort']
    >;
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 3,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 3, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        chunkingWorkerPort,
        chunkOverlap: 120,
        chunkSize: 1200,
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
        strategy: 'markdown',
        strategyExplicit: true,
        streamBatchSize: 25,
        tokenLimit: 3000,
        tokenTrueSizing: false,
        useStreamingForLargeFiles: false,
      },
      ports: {
        sql: {
          query: vi.fn().mockResolvedValue({ rows: [] }),
          runInTransaction,
        },
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        chunkingStrategy: 'markdown',
        chunkingWorkerPort,
        chunkOverlap: 120,
        chunkSize: 1200,
        embedQueueEnabled: false,
        forceStrategy: true,
        runInTransaction,
        streamBatchSize: 25,
        tokenLimit: 3000,
        tokenTrueSizing: false,
        useStreamingForLargeFiles: false,
      })
    );
  });

  it('rejects immediately when the import signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEnhancedImport({
        abortSignal: controller.signal,
        baseImportRunner: vi.fn(),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: false,
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes the abort signal into chunking options', async () => {
    const controller = new AbortController();
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 1,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      abortSignal: controller.signal,
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        abortSignal: controller.signal,
      })
    );
  });

  it('rejects local embedding models when registry SQL access is unavailable', async () => {
    await expect(
      runEnhancedImport({
        baseImportRunner: createBaseRunner([
          { chunksCreated: 1, existed: false, id: '1', imported: true },
        ]),
        chunking: {
          deps: { chunkRepository: {} as never, repository: {} as never },
          enabled: true,
        },
        embedding: {
          chunkRepository: {} as never,
          enabled: true,
          model: 'local::requires-sql-model',
          resolveTargetEmbeddingSetId: () => 'requires-sql-set',
          service: {} as never,
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(['1']),
        },
      })
    ).rejects.toThrow('Database access is required to resolve local embedding models.');
  });

  it('keeps a matching preferred embedding set without inserting a replacement', async () => {
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'local::preferred-model' }] });
      }
      if (sql.includes('FROM models')) {
        return Promise.resolve({
          rows: [
            {
              capabilities: { defaultDimension: 512, type: 'embedding' },
              id: 'preferred-model',
              providerId: 'transformers',
            },
          ],
        });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.resolve({
          rows: [
            {
              dimensions: 512,
              distance: 'cosine',
              id: 'preferred-set',
              modelKey: 'local::preferred-model',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const resolvedSetIdSpy = vi.fn();
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        chunksCreated: 1,
        existed: false,
        id: '1',
        imported: true,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'local::preferred-model',
        onResolvedTargetSetId: resolvedSetIdSpy,
        resolveTargetEmbeddingSetId: () => 'preferred-set',
        service: {} as never,
      },
      ports: {
        sql: {
          query: sqlPortQuery,
          runInTransaction: vi.fn(),
        },
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(resolvedSetIdSpy).toHaveBeenCalledWith('preferred-set');
    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ targetEmbeddingSetId: 'preferred-set' })
    );
    expect(
      sqlPortQuery.mock.calls.some(
        ([statement]) =>
          typeof statement === 'string' && statement.startsWith('INSERT INTO embedding_sets')
      )
    ).toBe(false);
  });

  it('canonicalizes a reused embedding set and exposes transactional queue enqueue options', async () => {
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const runInTransaction = vi.fn();
    const sqlPortQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT model_key AS "modelKey" FROM embedding_sets WHERE id = $1')) {
        return Promise.resolve({ rows: [{ modelKey: 'local::canonical-tx-model' }] });
      }
      if (sql.includes('FROM models')) {
        return Promise.resolve({
          rows: [
            {
              capabilities: { defaultDimension: 256, type: 'embedding' },
              id: 'canonical-tx-model',
              providerId: 'transformers',
            },
          ],
        });
      }
      if (
        sql.startsWith(
          'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
        )
      ) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
        return Promise.resolve({
          rows: [{ id: 'reused-set', modelKey: 'canonical-tx-model' }],
        });
      }
      if (sql.startsWith('UPDATE embedding_sets SET model_key = $1 WHERE id = $2')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const tx = {} as never;
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.enqueueJobsForChunksTx?.(
        tx,
        [
          {
            content: 'transactional content',
            contentHash: 'hash-tx',
            fileRecordId: '1',
            id: 'chunk-tx',
          } as never,
        ],
        '1'
      );
      return [
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        } satisfies EnhancedImportResult,
      ];
    });

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'local::canonical-tx-model',
        resolveTargetEmbeddingSetId: () => 'preferred-for-reuse',
        service: {} as never,
      },
      ports: {
        embeddingQueue: queuePort,
        sql: {
          query: sqlPortQuery,
          runInTransaction,
        },
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(sqlPortQuery).toHaveBeenCalledWith(
      'UPDATE embedding_sets SET model_key = $1 WHERE id = $2',
      ['local::canonical-tx-model', 'reused-set']
    );
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        model: 'local::canonical-tx-model',
        provider: 'local',
        targetDimension: 256,
        targetEmbeddingSetId: 'reused-set',
        transaction: tx,
      })
    );
  });

  it('exposes desktop atomic chunk/job enqueue options without callback transactions', async () => {
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn().mockResolvedValue(undefined);
    const sqlPort = {
      insertChunksAndEnqueueEmbeddingJobs,
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM models')) {
          return Promise.resolve({
            rows: [
              {
                capabilities: { defaultDimension: 384, type: 'embedding' },
                id: 'atomic-model',
                providerId: 'transformers',
              },
            ],
          });
        }
        if (
          sql.startsWith(
            'SELECT id, model_key AS "modelKey", dimensions, distance FROM embedding_sets WHERE id = $1'
          )
        ) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM embedding_sets s') && sql.includes('model_key IN')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as SqlExecutorPort & {
      insertChunksAndEnqueueEmbeddingJobs: typeof insertChunksAndEnqueueEmbeddingJobs;
    };
    const chunk = {
      content: 'atomic content',
      contentHash: 'hash-atomic',
      fileRecordId: '1',
      id: 'chunk-atomic',
    } as never;
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.insertChunksAndEnqueueEmbeddingJobs?.([chunk], '1');
      return [
        {
          chunksCreated: 1,
          existed: false,
          id: '1',
          imported: true,
        } satisfies EnhancedImportResult,
      ];
    });

    await runEnhancedImport({
      baseImportRunner: createBaseRunner([
        { chunksCreated: 1, existed: false, id: '1', imported: true },
      ]),
      chunking: {
        deps: { chunkRepository: {} as never, repository: {} as never },
        enabled: true,
      },
      embedding: {
        chunkRepository: {} as never,
        enabled: true,
        model: 'local::atomic-model',
        resolveTargetEmbeddingSetId: () => 'atomic-set',
        service: null,
      },
      ports: {
        embeddingQueue: queuePort,
        sql: sqlPort,
      },
      processChunkingImpl: chunkingImpl,
      progressHandlers: {
        update: (updater) => updater(null),
      },
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(['1']),
      },
    });

    expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      [chunk],
      '1',
      expect.objectContaining({
        model: 'local::atomic-model',
        provider: 'local',
        targetDimension: 384,
        targetEmbeddingSetId: null,
      })
    );
    expect(queuePort.enqueueBatch).not.toHaveBeenCalled();
  });
});
