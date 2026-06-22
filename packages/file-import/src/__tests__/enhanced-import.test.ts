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
  beforeEach(() => {
    resolveHostedProviderApiKeyMock.mockResolvedValue('test-api-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resolveHostedProviderApiKeyMock.mockReset();
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

  it('does not throw error when embeddings disabled (chunks still get embedding_set_id)', async () => {
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
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

    const results = await runEnhancedImport({
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
    });

    // Should succeed and chunks should be created with embedding_set_id
    expect(results).toHaveLength(1);
    expect(results[0]?.chunksCreated).toBe(1);
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
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM models')) {
          return Promise.resolve({
            rows: [
              {
                id: 'mock-model',
                providerId: 'transformers',
                capabilities: JSON.stringify({ type: 'embedding', defaultDimension: 768 }),
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
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      embedding: {
        enabled: true,
        model: 'mock-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'set-1',
        targetDimension: 384,
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
        targetDimension: 384,
        provider: 'local',
        dimensionParameter: null,
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
            id: 'chunk-openai',
            fileRecordId: '1',
            content: 'hosted content',
            contentHash: 'hash-openai',
          } as never,
        ],
        '1'
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
    const resolvedSetIdSpy = vi.fn();

    const results = await runEnhancedImport({
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
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      embedding: {
        enabled: true,
        provider: 'openai',
        model: 'text-embedding-3-small',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-hosted-set',
        onResolvedTargetSetId: resolvedSetIdSpy,
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
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
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
      } satisfies EnhancedImportResult,
    ]);
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
        provider: 'openai',
        model: 'text-embedding-3-small',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-hosted-set',
        onResolvedTargetSetId: resolvedSetIdSpy,
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
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
            id: 'chunk-voyage',
            fileRecordId: '1',
            content: 'voyage content',
            contentHash: 'hash-voyage',
          } as never,
        ],
        '1'
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
      ports: { embeddingQueue: queuePort, sql: sqlPort },
      embedding: {
        enabled: true,
        provider: 'voyage',
        model: 'voyage-3-lite',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-voyage-set',
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
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
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({ rows: [] }),
            runInTransaction: vi.fn(),
          },
        },
        embedding: {
          enabled: true,
          provider: 'openai',
          model: 'text-embedding-3-small',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => null,
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toThrow('Hosted provider "openai" requires an API key before running embeddings.');
  });

  it('rejects enabled embeddings when neither a model nor target set is available', async () => {
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
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => null,
        },
        progressHandlers: {
          update: (updater) => updater(null),
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
          resolveTargetEmbeddingSetId: () => 'missing-set',
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toThrow('Unable to resolve embedding model for set "missing-set".');
  });

  it('rejects target-set-only embedding resolution when SQL access is missing', async () => {
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
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'sql-required-set',
        },
        progressHandlers: {
          update: (updater) => updater(null),
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
          resolveTargetEmbeddingSetId: () => 'invalid-key-set',
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toThrow('Embedding set invalid-key-set has invalid model key "   ".');
  });

  it('rejects local embedding models whose registry capabilities are malformed', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'broken-model',
            providerId: 'transformers',
            capabilities: '{invalid json',
          },
        ],
      }),
      runInTransaction: vi.fn(),
    };

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
          model: 'local::broken-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'broken-set',
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toThrow('Model "broken-model" has invalid capabilities JSON:');
  });

  it('rejects local registry rows that are not embedding models', async () => {
    const sqlPort: SqlExecutorPort = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'chat-model',
            providerId: 'transformers',
            capabilities: { type: 'chat', defaultDimension: 768 },
          },
        ],
      }),
      runInTransaction: vi.fn(),
    };

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
          model: 'local::chat-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'chat-set',
        },
        ports: { sql: sqlPort },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toThrow('Model "chat-model" is not an embedding model.');
  });

  it('rejects local registry rows with invalid dimensions and invalid payloads', async () => {
    const baseParams = {
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
      progressHandlers: {
        update: (updater: (prev: EnhancedImportProgress | null) => EnhancedImportProgress | null) =>
          updater(null),
      },
    };

    await expect(
      runEnhancedImport({
        ...baseParams,
        embedding: {
          enabled: true,
          model: 'local::zero-dimension-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'zero-dimension-set',
        },
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({
              rows: [
                {
                  id: 'zero-dimension-model',
                  providerId: 'transformers',
                  capabilities: { type: 'embedding', defaultDimension: 0 },
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
          enabled: true,
          model: 'local::invalid-payload-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'invalid-payload-set',
        },
        ports: {
          sql: {
            query: vi.fn().mockResolvedValue({
              rows: [
                {
                  id: 'invalid-payload-model',
                  providerId: 'transformers',
                  capabilities: null,
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
      'FROM models': () =>
        Promise.resolve({
          rows: [
            {
              id: 'db-model',
              providerId: 'transformers',
              capabilities: JSON.stringify({ type: 'embedding', defaultDimension: 768 }),
            },
          ],
        }),
      'SELECT model_key': () => Promise.resolve({ rows: [{ modelKey: 'local::db-model' }] }),
      'SELECT id, model_key': () =>
        Promise.resolve({
          rows: [{ id: 'set-2', modelKey: 'local::db-model', dimensions: 768, distance: 'cosine' }],
        }),
      'FROM embedding_sets s': () =>
        Promise.resolve({ rows: [{ id: 'set-2', modelKey: 'local::db-model' }] }),
      'INSERT INTO embedding_sets': () => Promise.resolve({ rows: [{ id: 'set-2' }] }),
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
        resolveTargetEmbeddingSetId: () => 'set-2',
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
              id: 'preferred-set',
              modelKey: 'local::different-model',
              dimensions: 384,
              distance: 'cosine',
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
              id: 'mock-model',
              providerId: 'transformers',
              capabilities: { type: 'embedding', defaultDimension: 768 },
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
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
      } satisfies EnhancedImportResult,
    ]);

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
        model: 'local::mock-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-set',
        onResolvedTargetSetId: resolvedSetIdSpy,
      },
      ports: { sql: sqlPort },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
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
              id: 'recover-model',
              providerId: 'transformers',
              capabilities: { type: 'embedding', defaultDimension: 768 },
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
        model: 'local::recover-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-recover-set',
        onResolvedTargetSetId: resolvedSetIdSpy,
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
      processChunkingImpl: vi
        .fn()
        .mockResolvedValue([{ id: '1', imported: true, existed: false, chunksCreated: 1 }]),
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
              id: 'query-failure-model',
              providerId: 'transformers',
              capabilities: { type: 'embedding', defaultDimension: 768 },
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
          model: 'local::query-failure-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'query-failure-set',
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

  it('passes explicit chunking configuration and transactions into chunking options', async () => {
    const runInTransaction = vi.fn();
    const chunkingWorkerPort = {} as NonNullable<
      Parameters<typeof runEnhancedImport>[0]['chunking']['chunkingWorkerPort']
    >;
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 3,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      request: {
        selectedFilePaths: new Set(['1']),
        fileTree: [],
        fileContents: {},
      },
      baseImportRunner: createBaseRunner([
        { id: '1', imported: true, existed: false, chunksCreated: 3 },
      ]),
      chunking: {
        enabled: true,
        deps: { repository: {} as never, chunkRepository: {} as never },
        strategy: 'markdown',
        strategyExplicit: true,
        chunkSize: 1200,
        chunkOverlap: 120,
        streamBatchSize: 25,
        tokenLimit: 3000,
        tokenTrueSizing: false,
        useStreamingForLargeFiles: false,
        chunkingWorkerPort,
      },
      ports: {
        sql: {
          query: vi.fn().mockResolvedValue({ rows: [] }),
          runInTransaction,
        },
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
    });

    expect(chunkingImpl.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        chunkingStrategy: 'markdown',
        forceStrategy: true,
        chunkSize: 1200,
        chunkOverlap: 120,
        streamBatchSize: 25,
        tokenLimit: 3000,
        tokenTrueSizing: false,
        useStreamingForLargeFiles: false,
        chunkingWorkerPort,
        runInTransaction,
        embedQueueEnabled: false,
      })
    );
  });

  it('rejects immediately when the import signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runEnhancedImport({
        abortSignal: controller.signal,
        request: {
          selectedFilePaths: new Set(['1']),
          fileTree: [],
          fileContents: {},
        },
        baseImportRunner: vi.fn(),
        chunking: {
          enabled: false,
          deps: { repository: {} as never, chunkRepository: {} as never },
        },
        progressHandlers: {
          update: (updater) => updater(null),
        },
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes the abort signal into chunking options', async () => {
    const controller = new AbortController();
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
      } satisfies EnhancedImportResult,
    ]);

    await runEnhancedImport({
      abortSignal: controller.signal,
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
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
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
          model: 'local::requires-sql-model',
          service: {} as never,
          chunkRepository: {} as never,
          resolveTargetEmbeddingSetId: () => 'requires-sql-set',
        },
        progressHandlers: {
          update: (updater) => updater(null),
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
              id: 'preferred-model',
              providerId: 'transformers',
              capabilities: { type: 'embedding', defaultDimension: 512 },
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
              id: 'preferred-set',
              modelKey: 'local::preferred-model',
              dimensions: 512,
              distance: 'cosine',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const resolvedSetIdSpy = vi.fn();
    const chunkingImpl = vi.fn().mockResolvedValue([
      {
        id: '1',
        imported: true,
        existed: false,
        chunksCreated: 1,
      } satisfies EnhancedImportResult,
    ]);

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
        model: 'local::preferred-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-set',
        onResolvedTargetSetId: resolvedSetIdSpy,
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
      processChunkingImpl: chunkingImpl,
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
              id: 'canonical-tx-model',
              providerId: 'transformers',
              capabilities: { type: 'embedding', defaultDimension: 256 },
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
            id: 'chunk-tx',
            fileRecordId: '1',
            content: 'transactional content',
            contentHash: 'hash-tx',
          } as never,
        ],
        '1'
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
        model: 'local::canonical-tx-model',
        service: {} as never,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'preferred-for-reuse',
      },
      ports: {
        embeddingQueue: queuePort,
        sql: {
          query: sqlPortQuery,
          runInTransaction,
        },
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
    });

    expect(sqlPortQuery).toHaveBeenCalledWith(
      'UPDATE embedding_sets SET model_key = $1 WHERE id = $2',
      ['local::canonical-tx-model', 'reused-set']
    );
    expect(queuePort.enqueueBatch).toHaveBeenCalledWith(
      expect.any(Array),
      '1',
      expect.objectContaining({
        transaction: tx,
        model: 'local::canonical-tx-model',
        targetEmbeddingSetId: 'reused-set',
        provider: 'local',
        targetDimension: 256,
      })
    );
  });

  it('exposes desktop atomic chunk/job enqueue options without callback transactions', async () => {
    const queuePort: EmbeddingJobQueuePort = {
      enqueueBatch: vi.fn().mockResolvedValue(undefined),
    };
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn().mockResolvedValue(undefined);
    const sqlPort = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM models')) {
          return Promise.resolve({
            rows: [
              {
                id: 'atomic-model',
                providerId: 'transformers',
                capabilities: { type: 'embedding', defaultDimension: 384 },
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
      insertChunksAndEnqueueEmbeddingJobs,
    } as SqlExecutorPort & {
      insertChunksAndEnqueueEmbeddingJobs: typeof insertChunksAndEnqueueEmbeddingJobs;
    };
    const chunk = {
      id: 'chunk-atomic',
      fileRecordId: '1',
      content: 'atomic content',
      contentHash: 'hash-atomic',
    } as never;
    const chunkingImpl = vi.fn().mockImplementation(async (_results, _deps, options) => {
      await options.insertChunksAndEnqueueEmbeddingJobs?.([chunk], '1');
      return [
        {
          id: '1',
          imported: true,
          existed: false,
          chunksCreated: 1,
        } satisfies EnhancedImportResult,
      ];
    });

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
        model: 'local::atomic-model',
        service: null,
        chunkRepository: {} as never,
        resolveTargetEmbeddingSetId: () => 'atomic-set',
      },
      ports: {
        embeddingQueue: queuePort,
        sql: sqlPort,
      },
      progressHandlers: {
        update: (updater) => updater(null),
      },
      processChunkingImpl: chunkingImpl,
    });

    expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      [chunk],
      '1',
      expect.objectContaining({
        model: 'local::atomic-model',
        targetEmbeddingSetId: null,
        provider: 'local',
        targetDimension: 384,
      })
    );
    expect(queuePort.enqueueBatch).not.toHaveBeenCalled();
  });
});
