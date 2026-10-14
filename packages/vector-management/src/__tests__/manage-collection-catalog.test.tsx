import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: () => null,
}));

import { ManageEmbeddingSetsDialog } from '../embedding-set-management/manage-embedding-sets-dialog';

afterEach(() => {
  Reflect.deleteProperty(window, 'collectionCatalog');
});
test('Manage renders canonical counts without a database and marks inactive vectors unavailable', async () => {
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
  render(
    <ManageEmbeddingSetsDialog db={null} onOpenChange={() => undefined} open repository={null} />
  );
  expect(await screen.findByText('Documents')).toBeVisible();
  expect(screen.getByText('2')).toBeVisible();
  expect(screen.getByText('4')).toBeVisible();
  expect(screen.getByText('Unavailable')).toHaveAttribute('title', 'Collection is not active');
});
test('Manage surfaces a catalog failure rather than offering an empty collection list', async () => {
  Object.defineProperty(window, 'collectionCatalog', {
    configurable: true,
    value: {
      snapshot: async () => ({
        error: refusal({
          category: 'availability',
          code: 'catalog.unavailable',
          message: 'Catalog read failed',
          remedy: 'Reopen the app.',
        }),
        ok: false,
      }),
    },
  });
  render(
    <ManageEmbeddingSetsDialog db={null} onOpenChange={() => undefined} open repository={null} />
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Catalog read failed');
  expect(
    screen.queryByText('No collections yet. Create your first collection to get started.')
  ).toBeNull();
});
