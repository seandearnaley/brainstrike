// @vitest-environment node
import type {
  IndexerCoverageBatch,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { beforeEach, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../db-main', () => ({ getDatabase: async () => ({}) }));
vi.mock('@brainstrike/db', () => ({
  EmbeddingSetsRepository: class {
    listEmbeddingSpaces = list;
  },
}));

import type { ListEmbeddingSetsInput } from '@brainstrike/agent';
import { runListEmbeddingSpacesWith } from '../../assistant-server/list-embedding-spaces-core';
import { pgliteRetrievalStore } from '../../assistant-server/retrieval-store-pglite';
import { catalogOnly } from './_c1-a-helpers';

/** The host's listEmbeddingSpaces: the shared core over Main's catalog reads. */
function runListEmbeddingSpaces(
  input: ListEmbeddingSetsInput,
  nativeIndexSearch: IndexSearchCapability
) {
  return runListEmbeddingSpacesWith(input, nativeIndexSearch, catalogOnly(pgliteRetrievalStore()));
}

const setId = '3a1a8c0b-01ee-4d13-9936-d8cc24edbd18';
const profile = {
  dimensions: 384,
  dtype: 'q4' as const,
  modelId: 'onnx-community/all-MiniLM-L6-v2',
};
const status: Extract<IndexerStatus, { kind: 'ready' }> = {
  authorizedCollectionIds: [setId],
  authorizedRootIds: ['53272cda-e23c-483e-851c-ea7cdc45606c'],
  collectionReadiness: [{ embeddingSetId: setId, scanComplete: false }],
  embedding: { indexMode: 'vector-configured', profile, profileHash: 'saved-profile' },
  kind: 'ready',
  rootReadiness: [],
  storeId: 'native-store',
};
const counts = { chunks: 15_919, indexedFiles: 1856, missingVectors: 0, vectors: 15_919 };
function capability(batch?: IndexerCoverageBatch): IndexSearchCapability {
  return {
    coverage: vi.fn(),
    coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(
      async () =>
        batch ?? {
          coverage: [
            {
              collections: [{ ...counts, embeddingSetId: setId }],
              embedding: status.embedding,
              roots: [],
              storeId: status.storeId,
              totals: counts,
              vectorCoverageComplete: true,
            },
          ],
          kind: 'current',
          status,
        }
    ),
    grep: vi.fn(),
    rebuild: vi.fn(),
    search: vi.fn(),
    status: vi.fn(async () => status),
  };
}
beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([
    {
      createdAt: '2026-10-05',
      description: null,
      dimensions: 384,
      distance: 'cosine',
      id: setId,
      modelId: profile.modelId,
      modelKey: 'local::model',
      name: 'Workspace',
      stats: {
        averageTokensPerChunk: 0,
        embeddedChunks: 0,
        fileCount: 2215,
        tokenizedChunkCount: 0,
        totalChunks: 0,
        totalTokens: 0,
      },
    },
  ]);
});
it('advertises the authorized native set and observed native counts instead of legacy PG counters', async () => {
  const native = capability();
  const result = await runListEmbeddingSpaces(
    { includeStats: true, workspaceIndexOnly: true },
    native
  );
  expect(result.workspaceIndex.embeddingSetId).toBe(setId);
  expect(result.spaces).toEqual([
    expect.objectContaining({
      coverage: {
        coveragePercent: 100,
        embeddedChunks: 15_919,
        fileCount: 1856,
        missingVectors: 0,
        scanComplete: false,
        source: 'native',
        totalChunks: 15_919,
        vectorCoverageComplete: true,
      },
      id: setId,
      isWorkspaceIndex: true,
    }),
  ]);
  expect(list).toHaveBeenCalledWith({ includeStats: true });
  expect(native.coverageBatch).toHaveBeenCalledWith([{ collectionId: setId, rootIds: [] }]);
});
it('reports invalidated native coverage explicitly and never replaces it with legacy counters', async () => {
  const result = await runListEmbeddingSpaces(
    { includeStats: true },
    capability({ code: 'native-coverage-observation-invalidated', kind: 'invalidated' })
  );
  expect(result).toMatchObject({
    coverageObservation: { code: 'native-coverage-observation-invalidated', kind: 'invalidated' },
  });
  expect(result.spaces[0]).not.toHaveProperty('coverage');
  expect(list).toHaveBeenCalledWith({ includeStats: true });
});

it('preserves ordinary collection statistics without advertising them as native search authority', async () => {
  const stats = {
    averageTokensPerChunk: 4,
    embeddedChunks: 10,
    fileCount: 3,
    tokenizedChunkCount: 20,
    totalChunks: 20,
    totalTokens: 80,
  };
  list.mockResolvedValueOnce([
    {
      createdAt: '2026-10-05',
      description: null,
      dimensions: 1536,
      distance: 'cosine',
      id: 'ordinary',
      modelId: 'hosted-model',
      modelKey: 'openai::model',
      name: 'User collection',
      stats,
    },
  ]);
  const result = await runListEmbeddingSpaces({ includeStats: true }, capability());
  expect(result.spaces[0]).toMatchObject({
    coverage: { ...stats, coveragePercent: 50 },
    id: 'ordinary',
    isWorkspaceIndex: false,
    nativeSearchAuthorized: false,
  });
});
