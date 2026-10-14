import { expect, test, vi } from 'vitest';
import { createCatalogRetrievalStore } from '../assistant-server/retrieval-store-catalog';

vi.mock('../db-main', () => ({
  getDatabase: () => {
    throw new Error('PGlite is unavailable');
  },
}));
const collection = {
  createdAt: '2026-10-13T20:00:00Z',
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'collection',
  modelId: 'model',
  modelKey: 'local::model',
};
test('host retrieval reads canonical collection/source/root facts without the retired DB', async () => {
  const store = createCatalogRetrievalStore({
    collections: async () => ({ collections: [collection] }),
    sourceCatalog: async () => ({
      files: [
        {
          chunksCount: null,
          chunksProcessed: false,
          content: null,
          contentHash: 'hash',
          createdAt: collection.createdAt,
          embeddingSetId: 'collection',
          fileId: 'file',
          fileName: 'a.txt',
          path: '/root/a.txt',
          rootId: 'root',
          stat: { mtimeMs: 0, size: 3 },
          updatedAt: collection.createdAt,
        },
      ],
    }),
    workspaceRoots: async () => ({
      roots: [
        {
          createdAt: 0,
          displayName: 'My folder',
          id: 'root',
          kind: 'path',
          lastVerifiedAt: 0,
          path: '/root',
          status: 'live',
        },
      ],
    }),
  });
  expect(await store.embeddingSet('collection')).toEqual({
    dimensions: 384,
    distance: 'cosine',
    modelId: 'model',
    modelKey: collection.modelKey,
  });
  expect((await store.fileRecords(['file'])).get('file')).toEqual({
    id: 'file',
    name: 'a.txt',
    path: '/root/a.txt',
    rootId: 'root',
    rootName: 'My folder',
    tokenCount: null,
  });
  expect(await store.embeddingSpaces({ includeStats: true })).toEqual([
    { ...collection, description: null, name: null, statsUnavailableReason: expect.any(String) },
  ]);
});
