import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import type { BoundaryTransport } from '@brainstrike/assistant-contract/boundary-result';
import { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import type { CollectionPickerCollection } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseDemoCollectionDialogs } from '../components/database-demo-collection-dialogs';
import { useCollectionDialogs } from '../hooks/use-collection-dialogs';

const collection: CollectionPickerCollection = {
  category: null,
  chunkCount: 1,
  createdAt: '2026-10-13T00:00:00.000Z',
  description: null,
  dimensions: 384,
  distance: 'cosine',
  embeddingCount: 0,
  fileCount: 1,
  id: 'collection',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Imported files',
  tags: null,
};
afterEach(() => vi.unstubAllGlobals());

it('passes the actual native catalog repository to Delete and waits for its committed result', async () => {
  const removed = Promise.withResolvers<boolean>();
  const remove = vi.fn<CollectionCatalogCapability['delete']>(() => removed.promise);
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected catalog operation');
  };
  const catalog: BoundaryTransport<CollectionCatalogCapability> = {
    create: unavailable,
    delete: async (id) => ({ ok: true, value: await remove(id) }),
    ensureWorkspaceIndex: unavailable,
    get: unavailable,
    list: unavailable,
    snapshot: unavailable,
    update: unavailable,
  };
  vi.stubGlobal('collectionCatalog', catalog);
  const activeDeleted = vi.fn();
  function Surface() {
    const dialogs = useCollectionDialogs();
    const repository = useEmbeddingSetsRepository();
    return (
      <>
        <button onClick={() => dialogs.handleDeleteCollection(collection)} type="button">
          Open delete
        </button>
        <DatabaseDemoCollectionDialogs
          activeCollectionId={collection.id}
          collectionDialogs={dialogs}
          createDialog={null}
          embeddingSetsRepository={repository}
          onActiveCollectionDeleted={activeDeleted}
        />
      </>
    );
  }
  render(<Surface />);
  fireEvent.click(screen.getByRole('button', { name: 'Open delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Collection' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(collection.id));
  expect(activeDeleted).not.toHaveBeenCalled();
  removed.resolve(true);
  await waitFor(() => expect(activeDeleted).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: 'Delete Collection' })).not.toBeInTheDocument();
});
