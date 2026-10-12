import type { HybridSearchInput, RuntimeData } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dbQueryMock,
  embedMock,
  findByIdsMock,
  fullTextSearchMock,
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
  fullTextSearchMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  getKeyMock: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  resolveHostedProviderApiKeyMock: vi.fn(),
  searchSimilarMock: vi.fn(),
}));

// Stub the repository (both search arms), keep the REAL HybridSearchService so
// the test exercises the genuine RRF fusion path the tool must route through.
vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    FileChunkRepository: class {
      fullTextSearch(query: string, options: unknown) {
        return fullTextSearchMock(query, options);
      }
      searchSimilar(embedding: number[], options: unknown) {
        return searchSimilarMock(embedding, options);
      }
    },
    FileRecordRepository: class {
      findByIds(ids: readonly string[]) {
        return findByIdsMock(ids);
      }
    },
  };
});
vi.mock('@brainstrike/db/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db/react')>();
  return {
    ...actual,
    FileChunkRepository: class {
      fullTextSearch(query: string, options: unknown) {
        return fullTextSearchMock(query, options);
      }
      searchSimilar(embedding: number[], options: unknown) {
        return searchSimilarMock(embedding, options);
      }
    },
    FileRecordRepository: class {
      findByIds(ids: readonly string[]) {
        return findByIdsMock(ids);
      }
    },
  };
});

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

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
}));

vi.mock('../../secrets', () => ({
  getSecretsService: () => ({
    getKey: getKeyMock,
  }),
}));

import type {
  IndexerSearchHit,
  IndexerStatus,
} from '@brainstrike/indexing-contract/indexer-client';
import { runHybridSearchWith } from '../../assistant-server/hybrid-search-core';
import type { RetrievalToolDependencies } from '../../assistant-server/retrieval-core';
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

const workspaceIndexRuntime = {
  workspaceIndexEmbeddingSetId: 'ws-set',
  workspaceIndexingEnabled: true,
  workspaceIndexStatusState: 'idle',
  workspaceRoots: [{ displayName: 'ws', path: '/tmp/ws', rootId: 'root-1' }],
} as RuntimeData;

/**
 * The host's hybridSearch: the shared core `retrievalToolExecutors` runs, over
 * Main's native index and catalog reads (no legacy PG path).
 */
function hostHybrid(
  input: HybridSearchInput,
  runtimeData: RuntimeData | undefined,
  dependencies: RetrievalToolDependencies
) {
  return runHybridSearchWith(input, runtimeData, dependencies, catalogOnly(pgliteRetrievalStore()));
}

function nativeChunk(id: string, content: string, score: number): IndexerSearchHit {
  return {
    ...nativeHit,
    chunkId: id,
    content,
    fileId: `file-${id}`,
    relativePath: `${id}.ts`,
    rootId: 'root-1',
    score,
  };
}

describe('desktop hybrid search tool on the native index', () => {
  let f = nativeRetrievalFixture();
  let dependencies: RetrievalToolDependencies = {};

  beforeEach(() => {
    vi.clearAllMocks();
    f = nativeRetrievalFixture();
    f.setStatus({
      ...f.status,
      authorizedRootIds: ['root-1'],
      rootReadiness: [{ rootId: 'root-1', scanComplete: true }],
    } as IndexerStatus);
    vi.mocked(f.capability.coverage).mockImplementation(async ({ rootIds }) => ({
      collections: [{ ...nativeCounts, embeddingSetId: 'selected' }],
      embedding: nativeEmbedding,
      roots: rootIds.map((rootId) => ({ ...nativeCounts, rootId })),
      storeId: f.result.storeId,
      totals: nativeCounts,
      vectorCoverageComplete: true,
    }));
    const target = nativeChunk('chunk-target', 'lease fencing scheduler', 0.1);
    // Vector arm ranks the vector distractor first, target second.
    const vectorPool = [nativeChunk('chunk-vector-only', 'semantic neighbor', 0.01), target];
    // Lexical arm ranks the term-stuffed distractor first, target second.
    const bm25Pool = [nativeChunk('chunk-lexical-only', 'lease lease lease', 0.2), target];
    vi.mocked(f.capability.search).mockImplementation(async (request) => ({
      ...f.result,
      hits: request.mode === 'vector' ? vectorPool : bm25Pool,
    }));
    vi.mocked(f.capability.grep).mockImplementation(async () => ({ ...f.result, hits: [] }));
    dependencies = {
      embeddingHostManager: { queryEmbedding: f.queryEmbedding },
      nativeIndexSearch: f.capability,
    };
    findByIdsMock.mockImplementation((ids: readonly string[]) =>
      Promise.resolve(
        ids.map((id) => ({
          id,
          name: `${id}.ts`,
          path: `/repo/${id}.ts`,
          tokenCount: 10,
        }))
      )
    );
    dbQueryMock.mockImplementation((sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return Promise.resolve({ rows: [nativeEmbeddingSetRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('fuses the native arms over the saved collection with workspace root scoping', async () => {
    const result = await hostHybrid(
      { query: 'lease fencing scheduler', root: 'ws' },
      workspaceIndexRuntime,
      dependencies
    );

    // Every arm ran, scoped to the resolved workspace root.
    expect(f.capability.search).toHaveBeenCalledWith({
      limit: 100,
      mode: 'vector',
      profile: nativeProfile,
      rootIds: ['root-1'],
      vector: Array.from({ length: 384 }, () => 0.1),
    });
    expect(f.capability.search).toHaveBeenCalledWith({
      limit: 100,
      mode: 'bm25',
      rootIds: ['root-1'],
      text: 'lease fencing scheduler',
    });
    expect(f.capability.grep).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'lease fencing scheduler', rootIds: ['root-1'] })
    );

    // RRF fusion: the chunk found by BOTH arms outranks each single-arm leader.
    expect(result.embeddingSetId).toBe('selected');
    expect(result.results[0]?.id).toBe('chunk-target');
    expect(result.results[0]?.sourceCount).toBe(2);
    expect(result.results.map((item) => item.id)).toContain('chunk-vector-only');
    expect(result.results.map((item) => item.id)).toContain('chunk-lexical-only');
    expect(result.results[0]?.filePath).toBe('/repo/file-chunk-target.ts');
    expect(searchSimilarMock).not.toHaveBeenCalled();
    expect(fullTextSearchMock).not.toHaveBeenCalled();
  });

  it('prefers an explicit embeddingSetId and omits root scoping when no root is given', async () => {
    await hostHybrid(
      { embeddingSetId: 'selected', query: 'lease' },
      workspaceIndexRuntime,
      dependencies
    );

    expect(f.capability.search).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: 'selected', mode: 'vector', rootIds: [] })
    );
    expect(f.capability.search).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: 'selected', mode: 'bm25', rootIds: [] })
    );
    expect(f.capability.grep).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: 'selected', rootIds: [] })
    );
  });

  it('throws when no embedding collection is resolvable (no silent fallback)', async () => {
    f.setStatus({ ...f.status, authorizedCollectionIds: [] } as IndexerStatus);

    await expect(hostHybrid({ query: 'lease' }, undefined, dependencies)).rejects.toThrow(
      'Native assistant retrieval requires one saved authorized collection.'
    );
    expect(f.capability.search).not.toHaveBeenCalled();
    expect(f.capability.grep).not.toHaveBeenCalled();
  });

  it('surfaces a keyword-arm failure as an error, never a degraded result', async () => {
    vi.mocked(f.capability.search).mockImplementation(async (request) => {
      if (request.mode === 'bm25') {
        throw new Error('full-text query failed');
      }
      return { ...f.result, hits: [] };
    });

    await expect(
      hostHybrid({ query: 'lease fencing scheduler' }, workspaceIndexRuntime, dependencies)
    ).rejects.toThrow('Hybrid search failed. Please try again.');
    expect(f.capability.search).toHaveBeenCalledWith(expect.objectContaining({ mode: 'vector' }));
    expect(loggerError).toHaveBeenCalled();
  });
});
