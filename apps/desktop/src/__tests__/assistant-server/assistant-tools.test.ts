import {
  CREATE_EMBEDDING_SET_TOOL_ID,
  HYBRID_SEARCH_TOOL_ID,
  LIST_EMBEDDING_SETS_TOOL_ID,
  QUERY_FILE_TREE_TOOL_ID,
  QUEUE_STATUS_TOOL_ID,
  type RuntimeData,
  SYSTEM_DIAGNOSTICS_TOOL_ID,
} from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  dbExecMock,
  getDatabaseMock,
  getKeyMock,
  resolveHostedProviderApiKeyMock,
  embedMock,
  loggerDebug,
  loggerWarn,
  loggerError,
  embeddingSetsFindAllMock,
  embeddingSetsGetByModelKeyMock,
  embeddingSetsGetOrCreateSetMock,
  embeddingSetsGetByIdMock,
  coverageForSetMock,
  fileRecordFindByIdsMock,
  hybridSearchMock,
  queueStatsMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  dbExecMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getKeyMock: vi.fn(),
  resolveHostedProviderApiKeyMock: vi.fn(),
  embedMock: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  embeddingSetsFindAllMock: vi.fn(),
  embeddingSetsGetByModelKeyMock: vi.fn(),
  embeddingSetsGetOrCreateSetMock: vi.fn(),
  embeddingSetsGetByIdMock: vi.fn(),
  coverageForSetMock: vi.fn(),
  fileRecordFindByIdsMock: vi.fn(),
  hybridSearchMock: vi.fn(),
  queueStatsMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../../secrets', () => ({
  getSecretsService: () => ({
    getKey: getKeyMock,
  }),
}));

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: loggerDebug,
      warn: loggerWarn,
      error: loggerError,
      info: vi.fn(),
    }),
  };
});

vi.mock('@brainstrike/db', () => ({
  EmbeddingSetsRepository: class {
    findAll(): unknown {
      return embeddingSetsFindAllMock();
    }

    getByModelKey(modelKey: string): unknown {
      return embeddingSetsGetByModelKeyMock(modelKey);
    }

    getOrCreateSet(
      modelKey: string,
      modelId: string,
      dimensions: number,
      distance: string,
      options: { name: string; description?: string }
    ): unknown {
      return embeddingSetsGetOrCreateSetMock(modelKey, modelId, dimensions, distance, options);
    }

    getById(id: string): unknown {
      return embeddingSetsGetByIdMock(id);
    }
  },
  FileChunkRepository: class {
    getCoverageForSet(embeddingSetId: string): unknown {
      return coverageForSetMock(embeddingSetId);
    }
  },
  FileRecordRepository: class {
    findByIds(ids: readonly string[]): unknown {
      return fileRecordFindByIdsMock(ids);
    }
  },
  HybridSearchService: class {
    search(queryText: string, queryEmbedding: number[], options: unknown): unknown {
      return hybridSearchMock(queryText, queryEmbedding, options);
    }
  },
  JobQueue: class {
    getQueueStats(queueName: string): unknown {
      return queueStatsMock(queueName);
    }
  },
}));

vi.mock('@brainstrike/embeddings', () => {
  class MockHostedProvider {
    getModelInfo(_modelId: string): { dimensions: number } {
      return { dimensions: 2 };
    }

    getMetadata(_modelId: string): { dimensions: number; distance: string } {
      return { dimensions: 2, distance: 'cosine' };
    }

    embed(_input: { text: string; modelId: string }): unknown {
      return embedMock();
    }
  }

  return {
    OpenAIEmbeddingProvider: MockHostedProvider,
    GoogleEmbeddingProvider: MockHostedProvider,
    CohereEmbeddingProvider: MockHostedProvider,
    VoyageEmbeddingProvider: MockHostedProvider,
    isHostedProvider: (provider: string) => provider === 'openai',
    parseProviderModelKey: (modelKey: string) => {
      const [provider, modelId] = modelKey.split(':');
      if (!(provider && modelId)) {
        return null;
      }
      return { provider, modelId };
    },
    resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
  };
});

import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

describe('assistant-tools', () => {
  const now = new Date('2024-01-01T00:00:00.000Z');
  const fileRecordRows = [
    {
      id: 'file-1',
      name: 'index.ts',
      path: '/repo/src/index.ts',
      size: 120,
      tokenCount: 10,
      updatedAt: now.toISOString(),
    },
    {
      id: 'file-2',
      name: 'helpers.ts',
      path: '/repo/src/utils/helpers.ts',
      size: 80,
      tokenCount: null,
      updatedAt: now.toISOString(),
    },
    {
      id: 'file-3',
      name: '.env',
      path: '/repo/.env',
      size: 12,
      tokenCount: 1,
      updatedAt: now.toISOString(),
    },
    {
      id: 'file-4',
      name: 'README.md',
      path: '/repo/README.md',
      size: 5,
      tokenCount: 2,
      updatedAt: now.toISOString(),
    },
  ];

  const embeddingSet = {
    id: 'set-1',
    modelKey: 'openai:text-embedding-3-small',
    modelId: 'text-embedding-3-small',
    dimensions: 2,
    distance: 'cosine',
    name: 'Default',
    createdAt: now.toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    getDatabaseMock.mockResolvedValue({
      query: dbQueryMock,
      exec: dbExecMock,
    });
    getKeyMock.mockResolvedValue(undefined);
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.1, 0.2] } });

    embeddingSetsFindAllMock.mockResolvedValue([embeddingSet]);
    embeddingSetsGetByModelKeyMock.mockResolvedValueOnce([embeddingSet]).mockResolvedValueOnce([]);
    embeddingSetsGetOrCreateSetMock.mockResolvedValue({
      ...embeddingSet,
      id: 'set-2',
      name: 'Created Set',
    });
    embeddingSetsGetByIdMock.mockResolvedValue(embeddingSet);
    coverageForSetMock.mockResolvedValue({
      totalChunks: 10,
      chunksWithEmbeddingsForSet: 4,
    });
    fileRecordFindByIdsMock.mockResolvedValue([
      {
        id: 'file-1',
        name: 'index.ts',
        path: '/repo/src/index.ts',
      },
    ]);
    hybridSearchMock.mockResolvedValue({
      results: [
        {
          chunk: {
            id: 'chunk-1',
            content: 'hello world',
            chunkIndex: 0,
            chunkType: 'code',
            fileRecordId: 'file-1',
          },
          rrfScore: 0.91,
          sourceCount: 2,
          vectorSimilarity: 0.85,
          ftsRank: 0.42,
          headline: '<b>hello</b>',
          position: 1,
        },
      ],
      metadata: {
        vectorResultCount: 1,
        ftsResultCount: 1,
        fusedResultCount: 1,
        totalMs: 12,
      },
    });
    queueStatsMock.mockResolvedValue([{ queued: 2, running: 1, failed: 1, succeeded: 4 }]);

    dbQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM file_records') && sql.includes('token_count')) {
        return { rows: fileRecordRows };
      }
      if (sql.includes('FROM file_chunks') && sql.includes('file_record_id')) {
        return { rows: [{ fileRecordId: 'file-1' }] };
      }
      if (sql.includes('FROM file_records') && sql.includes('COUNT')) {
        return { rows: [{ count: '4' }] };
      }
      if (sql.includes('FROM file_chunks') && sql.includes('embedding IS NOT NULL')) {
        return { rows: [{ count: '2' }] };
      }
      if (sql.includes('FROM file_chunks') && sql.includes('COUNT')) {
        return { rows: [{ count: '6' }] };
      }
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [{ count: '1' }] };
      }
      if (
        sql.includes('FROM job_queue') &&
        sql.includes("state = 'succeeded'") &&
        sql.includes('COUNT')
      ) {
        return { rows: [{ count: '3' }] };
      }
      if (
        sql.includes('FROM job_queue') &&
        sql.includes("state = 'failed'") &&
        sql.includes('LIMIT 1')
      ) {
        return { rows: [{ error: 'boom' }] };
      }
      if (
        sql.includes('FROM job_queue') &&
        sql.includes("state = 'failed'") &&
        sql.includes('LIMIT 5')
      ) {
        return { rows: [{ error: 'boom' }, { error: ' ' }, { error: null }] };
      }
      if (sql.includes('FROM job_queue') && sql.includes('run_at')) {
        return {
          rows: [
            {
              runAt: now.toISOString(),
              updatedAt: new Date(now.getTime() + 1500).toISOString(),
            },
            {
              runAt: 'invalid',
              updatedAt: 'invalid',
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it('lists and creates embedding sets with coverage stats', async () => {
    const tools = buildDesktopAssistantTools({
      embeddingSetId: embeddingSet.id,
      mastraTools: {},
    } as RuntimeData);

    const listTool = tools[LIST_EMBEDDING_SETS_TOOL_ID];
    const listResult = await listTool.execute({ context: { includeStats: true } });

    expect(listResult.count).toBe(1);
    expect(listResult.coverageStats?.[embeddingSet.id]?.coveragePercent).toBe(40);

    const createTool = tools[CREATE_EMBEDDING_SET_TOOL_ID];
    const existingResult = await createTool.execute({
      context: {
        modelKey: embeddingSet.modelKey,
        name: 'Default',
        description: 'Primary embedding set',
      },
    });

    expect(existingResult.created).toBe(false);

    const createdResult = await createTool.execute({
      context: {
        modelKey: embeddingSet.modelKey,
        name: 'Created Set',
      },
    });

    expect(createdResult.created).toBe(true);
    expect(embeddingSetsGetOrCreateSetMock).toHaveBeenCalled();
  });

  it('queries file tree entries with filters and chunk flags', async () => {
    const tools = buildDesktopAssistantTools({
      embeddingSetId: embeddingSet.id,
      mastraTools: {},
    } as RuntimeData);

    const fileTreeTool = tools[QUERY_FILE_TREE_TOOL_ID];
    const result = await fileTreeTool.execute({
      context: {
        path: '/repo/',
        pattern: '**/*.ts',
        maxDepth: 3,
        includeHidden: false,
      },
    });

    expect(result.path).toBe('/repo/');
    expect(result.entries.some((entry) => entry.isDirectory && entry.path === '/repo/src')).toBe(
      true
    );

    const indexEntry = result.entries.find((entry) => entry.id === 'file-1');
    expect(indexEntry?.isChunked).toBe(true);
    expect(result.summary).toContain('Pattern: **/*.ts');
  });

  it('runs hybrid search, queue status, and diagnostics', async () => {
    const tools = buildDesktopAssistantTools({
      embeddingSetId: embeddingSet.id,
      mastraTools: {},
    } as RuntimeData);

    const hybridTool = tools[HYBRID_SEARCH_TOOL_ID];
    const hybridResult = await hybridTool.execute({
      context: {
        query: 'hello world',
        embeddingSetId: embeddingSet.id,
        limit: 5,
        vectorWeight: 0.7,
        ftsWeight: 0.3,
        vectorThreshold: 0.4,
        filePaths: ['/repo/src/index.ts'],
        chunkType: 'code',
      },
    });

    expect(hybridResult.results[0]?.filePath).toBe('/repo/src/index.ts');
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');

    const queueTool = tools[QUEUE_STATUS_TOOL_ID];
    const queueResult = await queueTool.execute({ context: { embeddingSetId: embeddingSet.id } });

    expect(queueResult.embeddingSetId).toBe(embeddingSet.id);
    expect(queueResult.coverage?.coveragePercent).toBeGreaterThan(0);
    expect(queueResult.queueCounts.failed).toBe(1);

    const diagnosticsTool = tools[SYSTEM_DIAGNOSTICS_TOOL_ID];
    const diagnosticsResult = await diagnosticsTool.execute({
      context: { categories: ['database', 'queue'] },
    });

    expect(diagnosticsResult.database?.tables.fileRecords).toBe(4);
    expect(diagnosticsResult.queue?.durableQueue.failed).toBe(1);
    expect(diagnosticsResult.issues.length).toBeGreaterThan(0);
  });
});
