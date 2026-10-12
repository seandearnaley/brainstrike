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

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: loggerError,
      info: vi.fn(),
      warn: loggerWarn,
    }),
  };
});

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

import {
  type QueryEmbeddingSpaceInput,
  QueryEmbeddingSpaceInputSchema,
  type RuntimeData,
} from '@brainstrike/agent';
import {
  type RetrievalToolDependencies,
  runQueryEmbeddingSpaceWith,
} from '../../assistant-server/retrieval-core';
import { pgliteRetrievalStore } from '../../assistant-server/retrieval-store-pglite';
import { runQueryEmbeddingSpace } from '../../assistant-server/retrieval-tool';
import {
  catalogOnly,
  nativeEmbeddingSetRow,
  nativeHit,
  nativeRetrievalFixture,
} from './_c1-a-helpers';

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

/**
 * Legacy-only (BST-1980): hosted query-embedding failures, selection snapshots
 * and the legacy input schema's filePaths cap. Host threads never reach Main's
 * PGlite similarity path; these cases are deleted with `LegacyRetrievalStore`
 * in C2.
 */
describe('retrieval-tool error paths (legacy PG path)', () => {
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
});

/**
 * The host's queryEmbeddingSpace: the shared core `retrievalToolExecutors`
 * runs, over Main's native index and catalog reads (no legacy PG path).
 */
function hostSemantic(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies
) {
  return runQueryEmbeddingSpaceWith(
    input,
    runtimeData,
    dependencies,
    catalogOnly(pgliteRetrievalStore())
  );
}

describe('retrieval-tool error paths on the native index', () => {
  let f = nativeRetrievalFixture();
  let dependencies: RetrievalToolDependencies = {};

  beforeEach(() => {
    vi.clearAllMocks();
    f = nativeRetrievalFixture();
    dependencies = {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    };
    findByIdsMock.mockResolvedValue([
      { id: 'file', name: 'file.ts', path: '/repo/file.ts', tokenCount: 42 },
    ]);
    dbQueryMock.mockImplementation(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return { rows: [nativeEmbeddingSetRow] };
      }
      return { rows: [] };
    });
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('refuses retrieved chunks that are missing source metadata', async () => {
    f.result.hits = [{ ...nativeHit, tokenCount: null }];

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow(
      'Native search returned a chunk outside the requested canonical scope or source metadata.'
    );
  });

  it('rejects selection snapshot ids, which the native index does not support', async () => {
    await expect(
      hostSemantic(
        { embeddingSetId: 'selected', query: 'hello', selectionSnapshotId: 'not-a-uuid' },
        undefined,
        dependencies
      )
    ).rejects.toThrow(
      'Native assistant retrieval does not support filePaths, selectionSnapshotId, or chunkType filters. Use a query and root scope.'
    );
    expect(f.queryEmbedding).not.toHaveBeenCalled();
  });

  it('surfaces safe errors when embedding set lookup fails', async () => {
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow('Unable to load embedding set metadata.');
  });

  it('surfaces safe guidance when no embedding collection is resolvable', async () => {
    f.setStatus({ ...f.status, authorizedCollectionIds: [] } as typeof f.status);

    await expect(hostSemantic({ query: 'hello' }, undefined, dependencies)).rejects.toThrow(
      'Native assistant retrieval requires one saved authorized collection.'
    );
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected retrieval errors', async () => {
    vi.mocked(f.capability.search).mockRejectedValueOnce(new Error('bad'));

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
  });

  it('does not expose raw unexpected retrieval errors in development mode', async () => {
    const originalNodeEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    vi.mocked(f.capability.search).mockRejectedValue(new Error('db failed for /private/workspace'));

    try {
      await expect(
        hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
      ).rejects.toThrow('Unable to retrieve context right now. Try again.');
      await expect(
        hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
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
    vi.mocked(f.capability.search).mockRejectedValue(
      new Error('db failed for /private/secret-workspace-path')
    );

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
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

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow('Unable to load embedding set metadata.');

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to load embedding set metadata',
      expect.objectContaining({
        embeddingSetId: 'selected',
        error: expect.objectContaining({ redacted: true }),
      })
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('/private/secret-db-socket-path');
  });
});
