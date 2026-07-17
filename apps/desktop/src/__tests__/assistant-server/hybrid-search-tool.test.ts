import type { RuntimeData } from '@brainstrike/agent';
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

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
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

import { runHybridSearch } from '../../assistant-server/hybrid-search-tool';

function chunk(id: string, content: string) {
  return {
    chunkIndex: 0,
    chunkType: 'text',
    content,
    embeddingSetId: 'ws-set',
    fileRecordId: `file-${id}`,
    id,
  };
}

const workspaceIndexRuntime = {
  workspaceIndexEmbeddingSetId: 'ws-set',
  workspaceIndexingEnabled: true,
  workspaceIndexStatusState: 'idle',
  workspaceRoots: [{ displayName: 'ws', path: '/tmp/ws', rootId: 'root-1' }],
} as RuntimeData;

describe('desktop hybrid search tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKeyMock.mockResolvedValue('test-api-key');
    resolveHostedProviderApiKeyMock.mockResolvedValue('fallback-api-key');
    embedMock.mockResolvedValue({ ok: true, value: { embedding: [0.25, 0.5] } });
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
    // Vector arm ranks the vector distractor first, target second.
    searchSimilarMock.mockResolvedValue([
      { chunk: chunk('chunk-vector-only', 'semantic neighbor'), rank: 1, similarity: 0.99 },
      { chunk: chunk('chunk-target', 'lease fencing scheduler'), rank: 2, similarity: 0.9 },
    ]);
    // Lexical arm ranks the term-stuffed distractor first, target second.
    fullTextSearchMock.mockResolvedValue([
      { chunk: chunk('chunk-lexical-only', 'lease lease lease'), rank: 8 },
      { chunk: chunk('chunk-target', 'lease fencing scheduler'), rank: 3 },
    ]);
    dbQueryMock.mockImplementation((sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('FROM embedding_sets')) {
        return Promise.resolve({
          rows: [
            {
              dimensions: 2,
              distance: null,
              modelId: 'text-embedding-3-small',
              modelKey: 'openai:text-embedding-3-small',
            },
          ],
        });
      }
      if (sql.includes('FROM file_records')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    getDatabaseMock.mockResolvedValue({ query: dbQueryMock });
  });

  it('routes through HybridSearchService with workspace-index embedding set and root scoping', async () => {
    const result = await runHybridSearch(
      { query: 'lease fencing scheduler', root: 'ws' },
      workspaceIndexRuntime
    );

    // Both arms ran, scoped to the resolved embedding set and workspace root.
    expect(searchSimilarMock).toHaveBeenCalledTimes(1);
    expect(searchSimilarMock.mock.calls[0]?.[0]).toEqual([0.25, 0.5]);
    expect(searchSimilarMock.mock.calls[0]?.[1]).toMatchObject({
      embeddingSetId: 'ws-set',
      rootIds: ['root-1'],
      threshold: 0.5,
    });
    expect(fullTextSearchMock).toHaveBeenCalledTimes(1);
    expect(fullTextSearchMock.mock.calls[0]?.[0]).toBe('lease fencing scheduler');
    expect(fullTextSearchMock.mock.calls[0]?.[1]).toMatchObject({ rootIds: ['root-1'] });

    // RRF fusion: the chunk found by BOTH arms outranks each single-arm leader.
    expect(result.embeddingSetId).toBe('ws-set');
    expect(result.results[0]?.id).toBe('chunk-target');
    expect(result.results[0]?.sourceCount).toBe(2);
    expect(result.results.map((item) => item.id)).toContain('chunk-vector-only');
    expect(result.results.map((item) => item.id)).toContain('chunk-lexical-only');
    expect(result.results[0]?.filePath).toBe('/repo/file-chunk-target.ts');
  });

  it('prefers an explicit embeddingSetId and omits root scoping when no root is given', async () => {
    await runHybridSearch(
      { embeddingSetId: 'explicit-set', query: 'lease' },
      workspaceIndexRuntime
    );

    expect(searchSimilarMock.mock.calls[0]?.[1]).toMatchObject({ embeddingSetId: 'explicit-set' });
    expect(searchSimilarMock.mock.calls[0]?.[1]).not.toHaveProperty('rootIds');
    expect(fullTextSearchMock.mock.calls[0]?.[1]).not.toHaveProperty('rootIds');
  });

  it('passes filePaths scoping through to BOTH search arms', async () => {
    await runHybridSearch({ filePaths: ['/repo/a.ts'], query: 'lease' }, workspaceIndexRuntime);

    expect(searchSimilarMock.mock.calls[0]?.[1]).toMatchObject({ filePaths: ['/repo/a.ts'] });
    expect(fullTextSearchMock.mock.calls[0]?.[1]).toMatchObject({ filePaths: ['/repo/a.ts'] });
  });

  it('throws when no embedding set is resolvable (no silent fallback)', async () => {
    await expect(runHybridSearch({ query: 'lease' }, undefined)).rejects.toThrow(
      /embedding space|Workspace Index/i
    );
    expect(searchSimilarMock).not.toHaveBeenCalled();
    expect(fullTextSearchMock).not.toHaveBeenCalled();
  });

  it('surfaces a keyword-arm failure (e.g. missing BM25 index) as an error, never a degraded result', async () => {
    fullTextSearchMock.mockRejectedValue(new Error('to_bm25query: index missing'));

    await expect(
      runHybridSearch({ query: 'lease fencing scheduler' }, workspaceIndexRuntime)
    ).rejects.toThrow('Hybrid search failed. Please try again.');
    expect(loggerError).toHaveBeenCalled();
  });
});
