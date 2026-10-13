/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: (...args: unknown[]) => JSON.stringify(args),
  usePGliteLiveQuery: () => ({ error: null, loading: false, refresh: vi.fn(), rows: [] }),
}));

import {
  fetchCollectionsSnapshot,
  formatCollectionLabel,
} from '../collection-select/collection-select';

afterEach(() => {
  Reflect.deleteProperty(window, 'collectionCatalog');
});
test('desktop collection snapshot uses its owner without a database and keeps inactive vector counts unavailable', async () => {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: {
      snapshot: async () => [
        {
          counts: { chunks: 4, files: 2, unprocessedFiles: 0 },
          createdAt: '2026-10-13T00:00:00.000Z',
          dimensions: 384,
          distance: 'cosine',
          id: 'collection',
          modelId: 'model',
          modelKey: 'local::model',
          name: 'Documents',
          vectors: { kind: 'unavailable', reason: 'Collection is not active' },
        },
      ],
    },
  });
  const [collection] = await fetchCollectionsSnapshot(null);
  expect(collection).toMatchObject({ chunkCount: 4, fileCount: 2, statsAvailable: false });
  expect(collection && formatCollectionLabel(collection)).toContain('2 files');
  expect(collection && formatCollectionLabel(collection)).toContain('unavailable');
});
test('desktop catalog failure remains a failure without querying another store', async () => {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: {
      snapshot: async () => {
        throw new Error('Catalog unavailable');
      },
    },
  });
  const query = vi.fn();
  await expect(fetchCollectionsSnapshot({ query } as never)).rejects.toThrow('Catalog unavailable');
  expect(query).not.toHaveBeenCalled();
});
