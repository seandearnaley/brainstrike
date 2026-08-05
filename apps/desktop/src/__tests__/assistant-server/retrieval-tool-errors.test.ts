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
  const schemas = await vi.importActual<
    typeof import('../../../../../packages/agent/src/tools/schemas')
  >('../../../../../packages/agent/src/tools/schemas');
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
    // REAL schema (BST-1020 review): the registry parses input with it
    // before the live entry, so the test adapter must too — an identity stub
    // here let cases assert schema-unreachable branches.
    QueryEmbeddingSpaceInputSchema: schemas.QueryEmbeddingSpaceInputSchema,
    RetrievalContextInputSchema: schemas.RetrievalContextInputSchema,
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
vi.mock('@brainstrike/db/react', () => ({
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

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerError,
    info: vi.fn(),
    warn: loggerWarn,
  }),
}));

vi.mock('@brainstrike/tokenization', () => ({
  countTokensHeuristic: (value: string) => value.length,
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../../secrets', async () => {
  const actual = await vi.importActual<typeof import('../../secrets')>('../../secrets');
  return {
    ...actual,
    getSecretsService: () => ({
      getKey: getKeyMock,
    }),
  };
});

import { QueryEmbeddingSpaceInputSchema } from '@brainstrike/agent';
import { runQueryEmbeddingSpace } from '../../assistant-server/retrieval-tool';

/**
 * BST-1020: the suite previously drove ~30 cases through the deleted
 * test-only tool factories. This adapter routes the SAME execute shape
 * through `runQueryEmbeddingSpace` — the entry the live registry actually
 * calls — so every assertion below stays byte-identical while exercising
 * the production path (including its error normalization, which moved from
 * the factories into the live entry in the same change).
 */
function liveRetrievalTool(
  runtimeData: Parameters<typeof runQueryEmbeddingSpace>[1],
  dependencies?: Parameters<typeof runQueryEmbeddingSpace>[2]
) {
  return {
    execute: async ({ context }: { context: Parameters<typeof runQueryEmbeddingSpace>[0] }) =>
      // Mirror the registry (resolveQueryEmbeddingSpaceInput in
      // assistant-tools.ts): strict schema parse BEFORE the live entry.
      runQueryEmbeddingSpace(
        QueryEmbeddingSpaceInputSchema.parse(context) as typeof context,
        runtimeData,
        dependencies
      ),
  };
}

/**
 * `runQueryEmbeddingSpace` can genuinely return the `{ status: 'unavailable' }`
 * branch (one test below asserts it), so the adapter keeps the honest union.
 * Tests that assert on available-only fields narrow through this throw.
 */
function expectAvailable(
  result: Awaited<ReturnType<typeof runQueryEmbeddingSpace>>
): Exclude<Awaited<ReturnType<typeof runQueryEmbeddingSpace>>, { status: 'unavailable' }> {
  if ('status' in result) {
    throw new Error('expected an available retrieval result');
  }
  return result;
}

describe('retrieval-tool error paths', () => {
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
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

    const result = expectAvailable(
      await tool.execute({
        context: {
          embeddingSetId: 'set-1',
          filePaths,
          query: 'query',
        },
      })
    );

    expect(result.selectionSnapshotId).toBe(snapshotId);
  });

  it('rejects invalid selection snapshot ids', async () => {
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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

  it('rejects oversized selection file path lists at the input schema', async () => {
    // BST-1020: the registry's schema parse (filePaths max 5000) is the LIVE
    // boundary; the core's selectionTooLarge throw behind it is defensive.
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });
    const filePaths = Array.from({ length: 5001 }, (_, index) => `file-${index}.ts`);

    await expect(
      tool.execute({
        context: {
          embeddingSetId: 'set-1',
          filePaths,
          query: 'hello',
        },
      })
    ).rejects.toThrow(/too big|at most 5000|5000/i);
  });

  it('surfaces safe errors when embedding set lookup fails', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'hello' },
      })
    ).rejects.toThrow('Unable to load embedding set metadata.');
  });

  it('surfaces safe selection guidance when no embedding space is resolvable', async () => {
    await expect(runQueryEmbeddingSpace({ query: 'hello' }, undefined)).rejects.toThrow(
      'Select an embedding space before querying semantic context.'
    );
  });

  it('sanitizes unexpected retrieval errors', async () => {
    searchSimilarMock.mockRejectedValueOnce(new Error('bad'));
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

    await expect(
      tool.execute({
        context: { embeddingSetId: 'set-1', query: 'hello' },
      })
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });

  it('does not expose raw unexpected retrieval errors in development mode', async () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    searchSimilarMock.mockRejectedValue(new Error('db failed for /private/workspace'));
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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
      if (originalNodeEnv === undefined) {
        Reflect.deleteProperty(process.env, 'NODE_ENV');
      } else {
        process.env['NODE_ENV'] = originalNodeEnv;
      }
    }
  });

  it('redacts the logged error for unexpected top-level retrieval failures', async () => {
    searchSimilarMock.mockRejectedValue(new Error('db failed for /private/secret-workspace-path'));
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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
    const tool = liveRetrievalTool({ embeddingSetId: 'set-1' });

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
