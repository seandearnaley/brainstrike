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

vi.mock('../../secrets', async () => {
  const actual = await vi.importActual<typeof import('../../secrets')>('../../secrets');
  return {
    ...actual,
    getSecretsService: () => ({
      getKey: getKeyMock,
    }),
  };
});

import type { QueryEmbeddingSpaceInput, RuntimeData } from '@brainstrike/agent';
import {
  type RetrievalToolDependencies,
  runQueryEmbeddingSpaceWith,
} from '../../assistant-server/retrieval-core';
import { pgliteRetrievalStore } from '../fixtures/pglite-retrieval-store';
import {
  catalogOnly,
  nativeEmbeddingSetRow,
  nativeHit,
  nativeRetrievalFixture,
} from './_c1-a-helpers';

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
    catalogOnly(pgliteRetrievalStore(getDatabaseMock))
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

  it('answers an embedding set lookup fault with the generic retrieval failure', async () => {
    // A database fault is not the model's to act on. Its text was matched
    // through as "safe", yet the execution guard still redacted it, so only a
    // typed refusal reaches the model (BST-1985).
    dbQueryMock.mockRejectedValueOnce(new Error('db exploded'));

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');
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
    ).rejects.toThrow('Unable to retrieve context right now. Try again.');

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
