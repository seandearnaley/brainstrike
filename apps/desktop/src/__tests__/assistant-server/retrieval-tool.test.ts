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
    embed(input: unknown) {
      return embedMock(input);
    }
  },
  GoogleEmbeddingProvider: class {
    embed(input: unknown) {
      return embedMock(input);
    }
  },
  hostedProviderRequiresApiKey: (provider: string) => !['ollama', 'lmstudio'].includes(provider),
  isHostedProvider: (provider: string) =>
    ['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'].includes(provider),
  isLocalProviderType: (provider: string) => ['local', 'transformers'].includes(provider),
  OpenAIEmbeddingProvider: class {
    embed(input: unknown) {
      return embedMock(input);
    }
  },
  parseProviderModelKey: (modelKey: string) => ({ provider: modelKey.split(':')[0] }),
  resolveHostedProviderApiKey: resolveHostedProviderApiKeyMock,
  VoyageEmbeddingProvider: class {
    embed(input: unknown) {
      return embedMock(input);
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

import type { QueryEmbeddingSpaceInput } from '@brainstrike/agent';
import type {
  IndexerSearchHit,
  IndexerStatus,
} from '@brainstrike/indexing-contract/indexer-client';
import {
  type RetrievalToolDependencies,
  runQueryEmbeddingSpaceWith,
} from '../../assistant-server/retrieval-core';
import { pgliteRetrievalStore } from '../../assistant-server/retrieval-store-pglite';
import {
  catalogOnly,
  nativeCounts,
  nativeEmbedding,
  nativeEmbeddingSetRow,
  nativeHit,
  nativeProfile,
  nativeRetrievalFixture,
} from './_c1-a-helpers';

/** Narrows the honest union to an available retrieval result. */
function expectAvailable(
  result: Awaited<ReturnType<typeof runQueryEmbeddingSpaceWith>>
): Exclude<Awaited<ReturnType<typeof runQueryEmbeddingSpaceWith>>, { status: 'unavailable' }> {
  if ('status' in result) {
    throw new Error('expected an available retrieval result');
  }
  return result;
}

/**
 * The host's queryEmbeddingSpace: the shared core `retrievalToolExecutors`
 * runs, over Main's native index and catalog reads (no legacy PG path).
 */
function hostSemantic(
  input: QueryEmbeddingSpaceInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies,
  signal?: AbortSignal
) {
  return runQueryEmbeddingSpaceWith(
    input,
    runtimeData,
    dependencies,
    catalogOnly(pgliteRetrievalStore()),
    signal
  );
}

const nativeChunk: IndexerSearchHit = {
  ...nativeHit,
  chunkId: 'chunk-1',
  chunkType: 'text',
  content: 'Hello world',
  endLine: 12,
  endOffset: 155,
  fileId: 'file-1',
  startLine: 10,
  startOffset: 120,
  tokenCount: 4,
};

function catalogQuery(fileRows: unknown[] = []) {
  return async (sql: string): Promise<{ rows: unknown[] }> => {
    if (sql.includes('FROM embedding_sets')) {
      return { rows: [nativeEmbeddingSetRow] };
    }
    if (sql.includes('FROM file_records')) {
      return { rows: fileRows };
    }
    return { rows: [] };
  };
}

describe('retrieval-tool on the native index', () => {
  let f = nativeRetrievalFixture();
  let dependencies: RetrievalToolDependencies = {};

  beforeEach(() => {
    vi.clearAllMocks();
    f = nativeRetrievalFixture();
    f.result.hits = [nativeChunk];
    dependencies = {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    };
    findByIdsMock.mockResolvedValue([
      { id: 'file-1', name: 'file.ts', path: '/repo/file.ts', tokenCount: 42 },
    ]);
    dbQueryMock.mockImplementation(catalogQuery());
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('retrieves and packs context', async () => {
    const result = expectAvailable(
      await hostSemantic(
        { embeddingSetId: 'selected', query: '  Hello  ' },
        { embeddingSetId: 'set-1', selectionFilePaths: ['/repo/file.ts'], tokenBudget: 10 },
        dependencies
      )
    );

    expect(result.query).toBe('Hello');
    expect(result.embeddingSetId).toBe('selected');
    // The native semantic search returns at most 10 results.
    expect(result.limit).toBe(10);
    expect(result.threshold).toBe(0.3);
    expect(result.totalTokens).toBe(1);
    expect(result.context).toContain('Source 1: /repo/file.ts:10-12 (chunk 0)');
    expect(result.context).toContain('Hello world');
    expect(result.chunkContentIncludedInContext).toBe(true);
    expect(result.chunks[0]).not.toHaveProperty('content');
    expect(result.chunks[0]?.lineRange).toEqual({ end: 12, start: 10 });
    expect(result.chunks[0]?.offsets).toEqual({ end: 155, start: 120 });
    expect(result.selectionSnapshotId).toBeUndefined();
    // The runtime's selectionFilePaths/tokenBudget above are INERT on the live
    // path (omitImplicitContextRuntimeData strips them): the default budget —
    // not the runtime's 10 — proves the strip is exercised.
    expect(result.budget).toBe(4000);
    expect(f.capability.search).toHaveBeenCalledWith({
      collectionId: 'selected',
      limit: 100,
      mode: 'vector',
      profile: nativeProfile,
      rootIds: [],
      vector: Array.from({ length: 384 }, () => 0.1),
    });
    expect(searchSimilarMock).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalledWith('Embedding dimension mismatch', expect.anything());
  });

  it('refuses retrieval while the native index is not ready', async () => {
    f.setStatus({
      kind: 'unavailable',
      phase: 'blocked',
      reason: 'OpenAI key is required for Workspace Index.',
    });

    await expect(
      hostSemantic({ query: 'Where is assistant retrieval wired?' }, undefined, dependencies)
    ).rejects.toThrow(
      'Native search is unavailable. Rebuild or restore the native index before retrying.'
    );
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('does not query the local host when the tool was already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('tool stopped');
    controller.abort(reason);
    await expect(
      hostSemantic(
        { embeddingSetId: 'selected', query: 'hello' },
        undefined,
        dependencies,
        controller.signal
      )
    ).rejects.toBe(reason);
    expect(f.queryEmbedding).not.toHaveBeenCalled();
  });

  it('sanitizes a local host timeout without logging the query', async () => {
    f.queryEmbedding.mockRejectedValue(new Error('Embedding host request timed out'));

    await expect(
      hostSemantic(
        { embeddingSetId: 'selected', query: 'private query text' },
        undefined,
        dependencies
      )
    ).rejects.toThrow('Unable to retrieve context right now');
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('private query text');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('private query text');
  });

  it('surfaces a safe error when local embedding host is unavailable', async () => {
    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'where is database config' }, undefined, {
        nativeIndexSearch: f.capability,
      })
    ).rejects.toThrow('Local embedding query host is unavailable.');
  });

  it('rejects a query embedding that does not match the saved profile', async () => {
    f.queryEmbedding.mockResolvedValueOnce([0.25]);

    await expect(
      hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    ).rejects.toThrow('Native query embedding is invalid for the saved profile.');
    expect(f.capability.search).not.toHaveBeenCalled();
  });

  it('returns empty context when no chunks are found', async () => {
    f.result.hits = [];

    const result = expectAvailable(
      await hostSemantic({ embeddingSetId: 'selected', query: 'hello' }, undefined, dependencies)
    );

    expect(result.context).toBe('');
    expect(result.chunks).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });
});

describe('retrieval-tool multi-root on the native index', () => {
  const ROOTED_RUNTIME = {
    workspaceRoots: [
      { displayName: 'ProjectA', path: '/work/ProjectA', rootId: 'root-a' },
      { displayName: 'ProjectB', path: '/work/ProjectB', rootId: 'root-b' },
    ],
  } as unknown as RuntimeData;
  let f = nativeRetrievalFixture();
  let dependencies: RetrievalToolDependencies = {};

  beforeEach(() => {
    vi.clearAllMocks();
    f = nativeRetrievalFixture();
    f.result.hits = [{ ...nativeChunk, relativePath: 'src/file.ts', rootId: 'root-a' }];
    f.setStatus({
      ...f.status,
      authorizedRootIds: ['root-a', 'root-b'],
      rootReadiness: [
        { rootId: 'root-a', scanComplete: true },
        { rootId: 'root-b', scanComplete: true },
      ],
    } as IndexerStatus);
    vi.mocked(f.capability.coverage).mockImplementation(async ({ rootIds }) => ({
      collections: [{ ...nativeCounts, embeddingSetId: 'selected' }],
      embedding: nativeEmbedding,
      roots: rootIds.map((rootId) => ({ ...nativeCounts, rootId })),
      storeId: f.result.storeId,
      totals: nativeCounts,
      vectorCoverageComplete: true,
    }));
    dependencies = {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    };
    findByIdsMock.mockResolvedValue([
      { id: 'file-1', name: 'file.ts', path: 'src/file.ts', tokenCount: 42 },
    ]);
    dbQueryMock.mockImplementation(
      catalogQuery([{ id: 'file-1', rootId: 'root-a', rootName: 'ProjectA' }])
    );
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('labels retrieved chunks and the context string with their workspace root', async () => {
    const result = await hostSemantic(
      { embeddingSetId: 'selected', query: 'hello' },
      ROOTED_RUNTIME,
      dependencies
    );
    if ('status' in result) {
      throw new Error('expected a retrieval result');
    }
    expect(result.context).toContain('ProjectA');
    expect(result.chunks[0]?.metadata?.['rootName']).toBe('ProjectA');
    expect(result.chunks[0]?.metadata?.['rootId']).toBe('root-a');
  });

  it('scopes retrieval to the resolved root when `root` is provided', async () => {
    f.result.hits = [{ ...nativeChunk, relativePath: 'src/file.ts', rootId: 'root-b' }];
    await hostSemantic(
      { embeddingSetId: 'selected', query: 'hello', root: 'ProjectB' },
      ROOTED_RUNTIME,
      dependencies
    );
    expect(f.capability.search).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'vector', rootIds: ['root-b'] })
    );
  });

  it('errors clearly when `root` names a folder that is not open', async () => {
    await expect(
      hostSemantic(
        { embeddingSetId: 'selected', query: 'hello', root: 'Nope' },
        ROOTED_RUNTIME,
        dependencies
      )
    ).rejects.toThrow(/no folder "Nope"/i);
  });
});
