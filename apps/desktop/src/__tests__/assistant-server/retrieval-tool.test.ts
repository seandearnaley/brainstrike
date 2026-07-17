import type { RuntimeData } from '@brainstrike/agent';
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

vi.mock('@brainstrike/agent', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../packages/agent/src/tools/workspace-index-retrieval')
  >('../../../../../packages/agent/src/tools/workspace-index-retrieval');
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
        budget: this.budgetTokens,
        chunks: chunks.map((chunk, index) => ({
          ...chunk,
          rank: index + 1,
          tokenCount: 1,
          ...(chunk.startLine !== undefined && chunk.endLine !== undefined
            ? { lineRange: { end: chunk.endLine, start: chunk.startLine } }
            : {}),
          ...(chunk.startOffset !== undefined && chunk.endOffset !== undefined
            ? { offsets: { end: chunk.endOffset, start: chunk.startOffset } }
            : {}),
        })),
        remainingTokens: Math.max(this.budgetTokens - totalTokens, 0),
        skipped: 0,
        totalTokens,
      };
    }
  }

  return {
    ContextPacker: MockContextPacker,
    createWorkspaceIndexUnavailableResult: actual.createWorkspaceIndexUnavailableResult,
    hasWorkspaceIndexRuntimeStatus: actual.hasWorkspaceIndexRuntimeStatus,
    normalizeOptionalText: actual.normalizeOptionalText,
    normalizeWorkspaceIndexText: actual.normalizeWorkspaceIndexText,
    QueryEmbeddingSpaceInputSchema: {
      parse: (input: unknown) => input,
    },
    RetrievalContextInputSchema: {
      parse: (input: unknown) => input,
    },
    resolveWorkspaceIndexEmbeddingSetId: actual.resolveWorkspaceIndexEmbeddingSetId,
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
    findByIds(ids: readonly string[]) {
      return findByIdsMock(ids);
    }
  },
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
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
  hostedProviderRequiresApiKey: (provider: string) => !['ollama', 'lmstudio'].includes(provider),
  isHostedProvider: (provider: string) =>
    ['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'].includes(provider),
  isLocalProviderType: (provider: string) => ['local', 'transformers'].includes(provider),
  OpenAIEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
  parseProviderModelKey: (modelKey: string) => ({ provider: modelKey.split(':')[0] }),
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
  VoyageEmbeddingProvider: class {
    embed() {
      return embedMock();
    }
  },
}));

vi.mock('@brainstrike/utils', () => ({
  countEstimatedTokens: (value: string) => value.length,
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerError,
    info: vi.fn(),
    warn: loggerWarn,
  }),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerError,
    info: vi.fn(),
    warn: loggerWarn,
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

import {
  createQueryEmbeddingSpaceTool,
  createRetrievalTool,
  runQueryEmbeddingSpace,
} from '../../assistant-server/retrieval-tool';

describe('retrieval-tool', () => {
  const snapshotId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
    findByIdsMock.mockResolvedValue([
      {
        createdAt: new Date().toISOString(),
        id: 'file-1',
        name: 'file.ts',
        path: '/repo/file.ts',
        size: 123,
        tokenCount: 42,
        updatedAt: new Date().toISOString(),
      },
    ]);
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          chunkIndex: 0,
          chunkType: 'code',
          content: 'Hello world',
          embeddingSetId: 'set-1',
          endLine: 12,
          endOffset: 155,
          fileRecordId: 'file-1',
          id: 'chunk-1',
          startLine: 10,
          startOffset: 120,
          tokenCount: 4,
        },
        rank: 1,
        similarity: 0.9,
      },
    ]);

    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              dimensions: 2,
              distance: null,
              modelId: 'text-embedding-3-small',
              modelKey: 'openai:text-embedding-3-small',
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
      selectionFilePaths: ['/repo/file.ts'],
      tokenBudget: 10,
    });

    const result = await tool.execute({
      context: {
        embeddingSetId: 'set-1',
        filePaths: ['/repo/file.ts'],
        query: '  Hello  ',
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
    expect(result.chunks[0]?.lineRange).toEqual({ end: 12, start: 10 });
    expect(result.chunks[0]?.offsets).toEqual({ end: 155, start: 120 });
    expect(result.selectionSnapshotId).toBeUndefined();

    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      embeddingSetId: 'set-1',
      filePaths: ['/repo/file.ts'],
      limit: 20,
      threshold: 0.3,
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
      embeddingSetId: 'workspace-index-set',
      limit: 20,
      threshold: 0.3,
    });
  });

  it('lets retrieveContext input override active runtime context', async () => {
    const tool = createRetrievalTool({
      embeddingSetId: 'active-set',
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    });

    const result = await tool.execute({
      context: {
        embeddingSetId: 'model-supplied-set',
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result.embeddingSetId).toBe('model-supplied-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'model-supplied-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      embeddingSetId: 'model-supplied-set',
      limit: 20,
      threshold: 0.3,
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
        embeddingSetId: 'explicit-set',
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'explicit-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      embeddingSetId: 'explicit-set',
      limit: 20,
      threshold: 0.3,
    });
  });

  it('lets queryEmbeddingSpace input override active runtime context', async () => {
    const result = await runQueryEmbeddingSpace(
      {
        embeddingSetId: 'explicit-set',
        query: 'Where is assistant retrieval wired?',
      },
      {
        embeddingSetId: 'active-set',
        workspaceIndexEmbeddingSetId: 'workspace-index-set',
        workspaceIndexingEnabled: true,
        workspaceIndexStatusState: 'idle',
      }
    );

    expect(result.embeddingSetId).toBe('explicit-set');
    expect(dbQueryMock).toHaveBeenCalledWith(expect.stringContaining('FROM embedding_sets'), [
      'explicit-set',
    ]);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      embeddingSetId: 'explicit-set',
      limit: 20,
      threshold: 0.3,
    });
  });

  it('returns structured workspace index status when the default workspace index is blocked', async () => {
    const tool = createRetrievalTool({
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 1,
        lastError: 'provider key unavailable',
        pending: 3,
        processed: 7,
        totalQueued: 11,
      },
      workspaceIndexStatusState: 'blocked',
    });

    const result = await tool.execute({
      context: {
        query: 'Where is assistant retrieval wired?',
      },
    });

    expect(result).toEqual({
      message: 'Workspace Index is blocked: missing-provider-key.',
      query: 'Where is assistant retrieval wired?',
      reason: 'workspace-index-blocked',
      status: 'unavailable',
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
              dimensions: 2,
              distance: null,
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { embeddingSetId: 'set-1', query: 'hello' },
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
              dimensions: 2,
              distance: null,
              modelId: 'text-embedding-model',
              modelKey: 'lmstudio::text-embedding-model',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: { embeddingSetId: 'set-1', query: 'hello' },
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
              dimensions: 2,
              distance: null,
              modelId: 'Xenova/all-MiniLM-L6-v2',
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
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
      context: { embeddingSetId: 'set-1', query: 'where is database config' },
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
              dimensions: 2,
              distance: null,
              modelId: 'Xenova/all-MiniLM-L6-v2',
              modelKey: 'local::Xenova/all-MiniLM-L6-v2',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'where is database config' },
      })
    ).rejects.toThrow('Local embedding query host is unavailable.');
  });

  it('creates a selection snapshot when file paths exceed limit', async () => {
    getKeyMock.mockResolvedValue(undefined);
    const filePaths = Array.from({ length: 501 }, (_, index) => `file-${index}.ts`);

    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });
    const result = await tool.execute({
      context: {
        embeddingSetId: 'set-1',
        filePaths,
        query: 'query',
      },
    });

    expect(result.selectionSnapshotId).toBe(snapshotId);
    expect(searchSimilarMock).toHaveBeenCalledWith([0.25, 0.5], {
      embeddingSetId: 'set-1',
      limit: 20,
      selectionSnapshotId: snapshotId,
      threshold: 0.3,
    });
    expect(resolveHostedProviderApiKeyMock).toHaveBeenCalledWith('openai');
  });

  it('rejects when embedding dimensions do not match active set', async () => {
    embedMock.mockResolvedValueOnce({ ok: true, value: { embedding: [0.25] } });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'hello' },
      })
    ).rejects.toThrow('Embedding dimensions do not match the active set.');

    expect(loggerWarn).toHaveBeenCalledWith('Embedding dimension mismatch', {
      actual: 1,
      expected: 2,
    });
  });

  it('returns empty context when no chunks are found', async () => {
    searchSimilarMock.mockResolvedValueOnce([]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { embeddingSetId: 'set-1', query: 'hello' },
    });

    expect(result.context).toBe('');
    expect(result.chunks).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('reports and skips chunks missing source ranges', async () => {
    searchSimilarMock.mockResolvedValueOnce([
      {
        chunk: {
          chunkIndex: 0,
          chunkType: 'code',
          content: 'Old chunk without range',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          id: 'chunk-old',
          tokenCount: 2,
        },
        rank: 1,
        similarity: 0.91,
      },
      {
        chunk: {
          chunkIndex: 1,
          chunkType: 'code',
          content: 'Line-aware chunk',
          embeddingSetId: 'set-1',
          endLine: 21,
          endOffset: 230,
          fileRecordId: 'file-1',
          id: 'chunk-new',
          startLine: 20,
          startOffset: 200,
          tokenCount: 3,
        },
        rank: 2,
        similarity: 0.9,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    const result = await tool.execute({
      context: { embeddingSetId: 'set-1', query: 'hello' },
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
          chunkIndex: 0,
          chunkType: 'code',
          content: 'Old chunk without range',
          embeddingSetId: 'set-1',
          fileRecordId: 'file-1',
          id: 'chunk-old',
          tokenCount: 2,
        },
        rank: 1,
        similarity: 0.91,
      },
    ]);
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { embeddingSetId: 'set-1', query: 'hello' } })
    ).rejects.toThrow(
      'Retrieved chunks are missing source line metadata. Rebuild the embedding space.'
    );
    expect(loggerWarn).toHaveBeenCalledWith('All retrieved chunks are missing source ranges', {
      skippedForMissingSourceRange: 1,
    });
  });

  it('preserves the safe embedding-generation failure message', async () => {
    embedMock.mockResolvedValueOnce({ error: new Error('provider down'), ok: false });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { embeddingSetId: 'set-1', query: 'hello' } })
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
              dimensions: 2,
              distance: null,
              modelId: 'text-embedding-3-small',
              modelKey: 'openai:text-embedding-3-small',
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
        embeddingSetId: 'set-1',
        filePaths,
        query: 'query',
      },
    });

    expect(result.selectionSnapshotId).toBe(snapshotId);
  });

  it('rejects invalid selection snapshot ids', async () => {
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: {
          embeddingSetId: 'set-1',
          query: 'hello',
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
          embeddingSetId: 'set-1',
          filePaths,
          query: 'hello',
        },
      })
    ).rejects.toThrow('Selection exceeds retrieval limits.');
  });

  it('surfaces safe errors when embedding set lookup fails', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'hello' },
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

  it('surfaces safe query-embedding-space selection guidance from the tool factory', async () => {
    const tool = createQueryEmbeddingSpaceTool(undefined);

    await expect(
      tool.execute({
        context: { query: 'hello' },
      })
    ).rejects.toThrow('Select an embedding space before querying semantic context.');
  });

  it('sanitizes unexpected retrieval errors', async () => {
    searchSimilarMock.mockRejectedValueOnce(new Error('bad'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'hello' },
      })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });

  it('does not expose raw unexpected retrieval errors in development mode', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    searchSimilarMock.mockRejectedValue(new Error('db failed for /private/workspace'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    try {
      await expect(
        tool.execute({
          context: { embeddingSetId: 'set-1', query: 'hello' },
        })
      ).rejects.toThrow('Unable to retrieve context right now. Try again.');
      await expect(
        tool.execute({
          context: { embeddingSetId: 'set-1', query: 'hello' },
        })
      ).rejects.not.toThrow('/private/workspace');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('redacts the logged error for unexpected top-level retrieval failures', async () => {
    searchSimilarMock.mockRejectedValue(new Error('db failed for /private/secret-workspace-path'));
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { embeddingSetId: 'set-1', query: 'hello' } })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');

    expect(loggerError).toHaveBeenCalledWith(
      'Retrieval tool failed',
      expect.objectContaining({ error: expect.objectContaining({ redacted: true }) })
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('/private/secret-workspace-path');
  });

  it('redacts the logged error when embedding set metadata fails to load', async () => {
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        throw new Error('connection refused at /private/secret-db-socket-path');
      }
      return { rows: [] };
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({ context: { embeddingSetId: 'set-1', query: 'hello' } })
    ).rejects.toThrow('Unable to load embedding set metadata.');

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to load embedding set metadata',
      expect.objectContaining({
        embeddingSetId: 'set-1',
        error: expect.objectContaining({ redacted: true }),
      })
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('/private/secret-db-socket-path');
  });
});

describe('retrieval-tool multi-root', () => {
  const ROOTED_RUNTIME = {
    workspaceRoots: [
      { displayName: 'ProjectA', path: '/work/ProjectA', rootId: 'root-a' },
      { displayName: 'ProjectB', path: '/work/ProjectB', rootId: 'root-b' },
    ],
  } as unknown as RuntimeData;

  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
    findByIdsMock.mockResolvedValue([
      { id: 'file-1', name: 'file.ts', path: 'src/file.ts', tokenCount: 42 },
    ]);
    searchSimilarMock.mockResolvedValue([
      {
        chunk: {
          chunkIndex: 0,
          chunkType: 'code',
          content: 'Hello world',
          embeddingSetId: 'set-1',
          endLine: 12,
          endOffset: 155,
          fileRecordId: 'file-1',
          id: 'chunk-1',
          startLine: 10,
          startOffset: 120,
          tokenCount: 4,
        },
        rank: 1,
        similarity: 0.9,
      },
    ]);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return {
          rows: [
            {
              dimensions: 2,
              distance: null,
              modelId: 'text-embedding-3-small',
              modelKey: 'openai:text-embedding-3-small',
            },
          ],
        };
      }
      // Root-label lookup (aliased columns mirror the real query).
      if (sql.includes('FROM file_records')) {
        return { rows: [{ id: 'file-1', rootId: 'root-a', rootName: 'ProjectA' }] };
      }
      return { rows: [] };
    });
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('labels retrieved chunks and the context string with their workspace root', async () => {
    const result = await runQueryEmbeddingSpace(
      { embeddingSetId: 'set-1', query: 'hello' },
      ROOTED_RUNTIME
    );
    if ('status' in result) {
      throw new Error('expected a retrieval result');
    }
    expect(result.context).toContain('ProjectA');
    expect(result.chunks[0]?.metadata?.rootName).toBe('ProjectA');
    expect(result.chunks[0]?.metadata?.rootId).toBe('root-a');
  });

  it('scopes retrieval to the resolved root when `root` is provided', async () => {
    await runQueryEmbeddingSpace(
      { embeddingSetId: 'set-1', query: 'hello', root: 'ProjectB' },
      ROOTED_RUNTIME
    );
    expect(searchSimilarMock).toHaveBeenCalledWith(
      [0.25, 0.5],
      expect.objectContaining({ rootId: 'root-b' })
    );
  });

  it('errors clearly when `root` names a folder that is not open', async () => {
    await expect(
      runQueryEmbeddingSpace(
        { embeddingSetId: 'set-1', query: 'hello', root: 'Nope' },
        ROOTED_RUNTIME
      )
    ).rejects.toThrow(/no folder "Nope"/i);
  });
});
