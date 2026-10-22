import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
/** @vitest-environment happy-dom */
import { afterEach, expect, test } from 'vitest';

import {
  fetchCollectionsSnapshot,
  formatCollectionLabel,
} from '../collection-select/collection-select';

afterEach(() => {
  Reflect.deleteProperty(window, 'collectionCatalog');
});
test('desktop collection snapshot uses its owner and keeps inactive vector counts unavailable', async () => {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: {
      snapshot: async () => ({
        ok: true,
        value: [
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
      }),
    },
  });
  const [collection] = await fetchCollectionsSnapshot();
  expect(collection).toMatchObject({ chunkCount: 4, fileCount: 2, statsAvailable: false });
  expect(collection && formatCollectionLabel(collection)).toContain('2 files');
  expect(collection && formatCollectionLabel(collection)).toContain('unavailable');
});
test('desktop catalog failure remains a failure', async () => {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: {
      snapshot: async () => ({
        error: refusal({
          category: 'availability',
          code: 'catalog.unavailable',
          message: 'Catalog unavailable',
          remedy: 'Reopen the app.',
        }),
        ok: false,
      }),
    },
  });
  await expect(fetchCollectionsSnapshot()).rejects.toThrow('Catalog unavailable');
});
