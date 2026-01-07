import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  embedMock,
  findByIdMock,
  getDatabaseMock,
  getKeyMock,
  loggerError,
  loggerWarn,
  resolveHostedProviderApiKeyMock,
  searchSimilarMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  embedMock: vi.fn(),
  findByIdMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getKeyMock: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  resolveHostedProviderApiKeyMock: vi.fn(),
  searchSimilarMock: vi.fn(),
}));

vi.mock('@brainstrike/agent', () => {
  class MockContextPacker {
    private readonly budgetTokens: number;

    constructor(options: { budgetTokens: number }) {
      this.budgetTokens = options.budgetTokens;
    }

    pack(
      chunks: Array<{
        content: string;
        fileName?: string;
        filePath?: string;
        chunkIndex?: number;
      }>
    ) {
      const totalTokens = chunks.length;
      return {
        totalTokens,
        budget: this.budgetTokens,
        remainingTokens: Math.max(this.budgetTokens - totalTokens, 0),
        skipped: 0,
        chunks,
      };
    }
  }

  return {
    ContextPacker: MockContextPacker,
    RetrievalContextInputSchema: {
      parse: (input: unknown) => input,
    },
  };
});

vi.mock('@brainstrike/db', () => ({
  FileChunkRepository: class {
    searchSimilar(
      embedding: number[],
      options: {
        limit: number;
        threshold: number;
        embeddingSetId: string;
        filePaths?: string[];
        selectionSnapshotId?: string;
      }
    ) {
      return searchSimilarMock(embedding, options);
    }
  },
  FileRecordRepository: class {
    findById(id: string) {
      return findByIdMock(id);
    }
  },
}));

vi.mock('@brainstrike/embeddings', () => ({
  CohereEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  GoogleEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  OpenAIEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  VoyageEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  isHostedProvider: (provider: string) =>
    ['openai', 'google', 'cohere', 'voyage'].includes(provider),
  parseProviderModelKey: (modelKey: string) => ({ provider: modelKey.split(':')[0] }),
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
}));

vi.mock('@brainstrike/utils', () => ({
  countTokensHeuristic: (value: string) => value.length,
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../../secrets', () => ({
  getSecretsService: () => ({
    getKey: getKeyMock,
  }),
}));

import { createRetrievalTool } from '../../assistant-server/retrieval-tool';

describe('retrieval-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25] } });
    findByIdMock.mockResolvedValue({
      id: 'file-1',
      name: 'file.ts',
      path: '/repo/file.ts',
      tokenCount: 42,
    });
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          id: 'chunk-1',
          content: 'Hello world',
          tokenCount: 4,
          chunkIndex: 0,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 1,
      },
    ]);

    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'openai:text-embedding-3-small',
              modelId: 'text-embedding-3-small',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO selection_snapshots')) {
        return { rows: [{ id: 'snapshot-1' }] };
      }
      return { rows: [] };
    });

    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('retrieves and packs context with inline file paths', async () => {
    const tool = createRetrievalTool({
      embeddingSetId: 'set-1',
      tokenBudget: 10,
      selectionFilePaths: ['/repo/file.ts'],
    });

    const result = await tool.execute({
      context: {
        query: '  Hello  ',
        embeddingSetId: 'set-1',
        filePaths: ['/repo/file.ts'],
      },
    });

    expect(result.query).toBe('Hello');
    expect(result.embeddingSetId).toBe('set-1');
    expect(result.limit).toBe(20);
    expect(result.threshold).toBe(0.3);
    expect(result.totalTokens).toBe(1);
    expect(result.context).toContain('Source 1: /repo/file.ts (chunk 0)');
    expect(result.context).toContain('Hello world');
    expect(result.selectionSnapshotId).toBeUndefined();

    expect(searchSimilarMock).toHaveBeenCalledWith([0.25], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      filePaths: ['/repo/file.ts'],
    });
    expect(loggerWarn).toHaveBeenCalledWith('Embedding dimension mismatch', {
      expected: 2,
      actual: 1,
    });
  });

  it('creates a selection snapshot when file paths exceed limit', async () => {
    getKeyMock.mockResolvedValue(undefined);
    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: {
        query: 'query',
        embeddingSetId: 'set-1',
        filePaths,
      },
    });

    expect(result.selectionSnapshotId).toBe('snapshot-1');
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      selectionSnapshotId: 'snapshot-1',
    });
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');
  });

  it('surfaces safe errors for missing embedding set', async () => {
    const tool = createRetrievalTool(undefined);

    await expect(
      tool.execute({
        context: { query: 'hello' },
      })
    ).rejects.toThrow('Select an active embedding set to enable retrieval.');
  });

  it('sanitizes unexpected retrieval errors', async () => {
    embedMock.mockResolvedValueOnce({ ok: false, error: 'bad' });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });
});
