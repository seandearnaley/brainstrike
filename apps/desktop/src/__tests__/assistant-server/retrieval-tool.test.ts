import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  embedMock,
  findByIdsMock,
  getDatabaseMock,
  getKeyMock,
  loggerError,
  loggerWarn,
  resolveHostedProviderApiKeyMock,
  searchSimilarMock,
} = vi.hoisted(() => ({
  dbQueryMock: vi.fn(),
  embedMock: vi.fn(),
  findByIdsMock: vi.fn(),
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
        endLine?: number;
        endOffset?: number;
        fileName?: string;
        filePath?: string;
        chunkIndex?: number;
        startLine?: number;
        startOffset?: number;
      }>
    ) {
      const totalTokens = chunks.length;
      return {
        totalTokens,
        budget: this.budgetTokens,
        remainingTokens: Math.max(this.budgetTokens - totalTokens, 0),
        skipped: 0,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          rank: index + 1,
          tokenCount: 1,
          ...(chunk.startLine !== undefined && chunk.endLine !== undefined
            ? { lineRange: { start: chunk.startLine, end: chunk.endLine } }
            : {}),
          ...(chunk.startOffset !== undefined && chunk.endOffset !== undefined
            ? { offsets: { start: chunk.startOffset, end: chunk.endOffset } }
            : {}),
        })),
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
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
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
    findByIds(ids: readonly string[]) {
      return findByIdsMock(ids);
    }
  },
}));

vi.mock('@brainstrike/embeddings/provider-core', () => ({
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
  hostedProviderRequiresApiKey: (provider: string) => !['ollama', 'lmstudio'].includes(provider),
  isHostedProvider: (provider: string) =>
    ['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'].includes(provider),
  isLocalProviderType: (provider: string) => ['local', 'transformers'].includes(provider),
  parseProviderModelKey: (modelKey: string) => ({ provider: modelKey.split(':')[0] }),
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@brainstrike/text-splitter', () => ({
  countTokensHeuristic: (value: string) => value.length,
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
  const snapshotId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
    findByIdsMock.mockResolvedValue([
      {
        id: 'file-1',
        name: 'file.ts',
        path: '/repo/file.ts',
        tokenCount: 42,
        size: 123,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          id: 'chunk-1',
          content: 'Hello world',
          tokenCount: 4,
          chunkIndex: 0,
          startLine: 10,
          endLine: 12,
          startOffset: 120,
          endOffset: 155,
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
        return { rows: [{ id: snapshotId }] };
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
    expect(result.context).toContain('Source 1: /repo/file.ts:10-12 (chunk 0)');
    expect(result.context).toContain('Hello world');
    expect(result.chunkContentIncludedInContext).toBe(true);
    expect(result.chunks[0]).not.toHaveProperty('content');
    expect(result.chunks[0]?.lineRange).toEqual({ start: 10, end: 12 });
    expect(result.chunks[0]?.offsets).toEqual({ start: 120, end: 155 });
    expect(result.selectionSnapshotId).toBeUndefined();

    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      filePaths: ['/repo/file.ts'],
    });
    expect(loggerWarn).not.toHaveBeenCalledWith('Embedding dimension mismatch', expect.anything());
  });

  it('uses the workspace index embedding set when no explicit or runtime set is provided', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result.embeddingSetId).toBe('workspace-index-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'workspace-index-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'workspace-index-set',
    });
  });

  it('lets an explicit embedding set override the workspace index default', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
        embeddingSetId: 'explicit-set',
      },
    });

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'explicit-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'explicit-set',
    });
  });

  it('returns structured workspace index status when the default workspace index is blocked', async () => {
    const tool = createRetrievalTool({
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexStatusState: 'blocked',
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 1,
        pending: 3,
        processed: 7,
        totalQueued: 11,
        lastError: 'provider key unavailable',
      },
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      reason: 'workspace-index-blocked',
      message: 'Workspace Index is blocked: missing-provider-key.',
      query: 'Where is assistant retrieval wired?',
      workspaceIndex: {
        blockedReason: 'missing-provider-key',
        embeddingSetId: 'workspace-index-set',
        enabled: true,
        lastError: 'OpenAI key is required for Workspace Index.',
        paused: false,
        queueProgress: {
          failed: 1,
          lastError: 'provider key unavailable',
          pending: 3,
          processed: 7,
          totalQueued: 11,
        },
        statusState: 'blocked',
      },
    });
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('does not require API keys for local runtime embedding providers', async () => {
    getKeyMock.mockResolvedValue(undefined);
    resolveHostedProviderApiKeyMock.mockResolvedValue(undefined);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'ollama::nomic-embed-text',
              modelId: 'nomic-embed-text',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('ollama');
  });

  it('supports lmstudio runtime embedding providers without API keys', async () => {
    getKeyMock.mockResolvedValue(undefined);
    resolveHostedProviderApiKeyMock.mockResolvedValue(undefined);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'lmstudio::text-embedding-model',
              modelId: 'text-embedding-model',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('lmstudio');
  });

  it('uses the embedding host for local embedding set queries', async () => {
    const queryEmbeddingMock = vi.fn().mockResolvedValue([0.125, 0.75]);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              modelId: 'Xenova/all-MiniLM-L6-v2',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool(
      { embeddingSetId: 'set-1' },
      { embeddingHostManager: { queryEmbedding: queryEmbeddingMock } }
    );
    const result = await tool.execute({
      context: { query: 'where is database config', embeddingSetId: 'set-1' },
    });

    expect(result.embeddingSetId).toBe('set-1');
    expect(queryEmbeddingMock).toHaveBeenCalledWith({
      dimensions: 2,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      query: 'where is database config',
    });
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchSimilarMock).toHaveBeenCalledWith([0.125, 0.75], expect.anything());
  });

  it('surfaces a safe error when local embedding host is unavailable', async () => {
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
              modelId: 'Xenova/all-MiniLM-L6-v2',
              dimensions: 2,
              distance: null,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'where is database config', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Local embedding query host is unavailable.');
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

    expect(result.selectionSnapshotId).toBe(snapshotId);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      limit: 20,
      threshold: 0.3,
      embeddingSetId: 'set-1',
      selectionSnapshotId: snapshotId,
    });
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');
  });

  it('rejects when embedding dimensions do not match active set', async () => {
    embedMock.mockResolvedValueOnce({ ok: true, value: { embedding: [0.25] } });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Embedding dimensions do not match the active set.');

    expect(loggerWarn).toHaveBeenCalledWith('Embedding dimension mismatch', {
      expected: 2,
      actual: 1,
    });
  });

  it('returns empty context when no chunks are found', async () => {
    searchSimilarMock.mockResolvedValueOnce([]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.context).toBe('');
    expect(result.chunks).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('reports and skips chunks missing source ranges', async () => {
    searchSimilarMock.mockResolvedValueOnce([
      {
        chunk: {
          id: 'chunk-old',
          content: 'Old chunk without range',
          tokenCount: 2,
          chunkIndex: 0,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.91,
        rank: 1,
      },
      {
        chunk: {
          id: 'chunk-new',
          content: 'Line-aware chunk',
          tokenCount: 3,
          chunkIndex: 1,
          startLine: 20,
          endLine: 21,
          startOffset: 200,
          endOffset: 230,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.9,
        rank: 2,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { query: 'hello', embeddingSetId: 'set-1' },
    });

    expect(result.context).toContain('Line-aware chunk');
    expect(result.context).not.toContain('Old chunk without range');
    expect(result.chunks).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedForMissingSourceRange).toBe(1);
    expect(result.skippedSourceRangeChunks).toEqual([
      { chunkId: 'chunk-old', chunkIndex: 0, fileRecordId: 'file-1' },
    ]);
    expect(loggerWarn).toHaveBeenCalledWith('Some retrieved chunks are missing source ranges', {
      retrievedChunks: 2,
      skippedForMissingSourceRange: 1,
    });
  });

  it('throws a safe rebuild hint when all retrieved chunks are missing source ranges', async () => {
    searchSimilarMock.mockResolvedValueOnce([
      {
        chunk: {
          id: 'chunk-old',
          content: 'Old chunk without range',
          tokenCount: 2,
          chunkIndex: 0,
          chunkType: 'code',
          fileRecordId: 'file-1',
          embeddingSetId: 'set-1',
        },
        similarity: 0.91,
        rank: 1,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { query: 'hello', embeddingSetId: 'set-1' } })
    ).rejects.toThrow(
      'Retrieved chunks are missing source line metadata. Rebuild the embedding space.'
    );
    expect(loggerWarn).toHaveBeenCalledWith('All retrieved chunks are missing source ranges', {
      skippedForMissingSourceRange: 1,
    });
  });

  it('preserves the safe embedding-generation failure message', async () => {
    embedMock.mockResolvedValueOnce({ ok: false, error: new Error('provider down') });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { query: 'hello', embeddingSetId: 'set-1' } })
    ).rejects.toThrow('Unable to generate query embeddings for retrieval.');
  });

  it('continues when snapshot cleanup fails', async () => {
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('DELETE FROM selection_snapshots')) {
        throw new Error('cleanup failed');
      }
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
        return { rows: [{ id: snapshotId }] };
      }
      return { rows: [] };
    });

    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: {
        query: 'query',
        embeddingSetId: 'set-1',
        filePaths,
      },
    });

    expect(result.selectionSnapshotId).toBe(snapshotId);
  });

  it('rejects invalid selection snapshot ids', async () => {
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: {
          query: 'hello',
          embeddingSetId: 'set-1',
          selectionSnapshotId: 'not-a-uuid',
        },
      })
    ).rejects.toThrow('Selection snapshot reference is invalid.');
  });

  it('rejects oversized selection file path lists', async () => {
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const filePaths = Array.from({ length: 5001 }, (_, index) => `file-${index}.ts`);

    await expect(
      tool.execute({
        context: {
          query: 'hello',
          embeddingSetId: 'set-1',
          filePaths,
        },
      })
    ).rejects.toThrow('Selection exceeds retrieval limits.');
  });

  it('surfaces safe errors when embedding set lookup fails', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Unable to load embedding set metadata.');
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
    searchSimilarMock.mockRejectedValueOnce(new Error('bad'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { query: 'hello', embeddingSetId: 'set-1' },
      })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });
});
