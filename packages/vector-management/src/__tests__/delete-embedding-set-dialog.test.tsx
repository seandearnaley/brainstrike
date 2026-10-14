import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeleteEmbeddingSetDialog } from '../embedding-set-management/delete-embedding-set-dialog';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/ui', async (original) => ({
  ...(await original<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));
afterEach(() => vi.clearAllMocks());
const collection = {
  chunkCount: 2,
  createdAt: '2026-10-13T00:00:00.000Z',
  dimensions: 384,
  distance: 'cosine' as const,
  id: 'collection-1',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  name: 'Workspace',
};

it('waits for the collection owner before closing and notifying deletion', async () => {
  let complete: ((removed: boolean) => void) | undefined;
  const remove = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  const onOpenChange = vi.fn();
  const onSetDeleted = vi.fn();
  render(
    <DeleteEmbeddingSetDialog
      embeddingSet={collection}
      onOpenChange={onOpenChange}
      onSetDeleted={onSetDeleted}
      open
      repository={{ delete: remove }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete Collection' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(collection.id));
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSetDeleted).not.toHaveBeenCalled();
  complete?.(true);
  await waitFor(() => expect(onSetDeleted).toHaveBeenCalledWith(collection.id));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('keeps the dialog open and reports owner retirement failure', async () => {
  const remove = vi.fn(async () => {
    throw new Error('Native index retirement failed');
  });
  const onOpenChange = vi.fn();
  const onSetDeleted = vi.fn();
  render(
    <DeleteEmbeddingSetDialog
      embeddingSet={collection}
      onOpenChange={onOpenChange}
      onSetDeleted={onSetDeleted}
      open
      repository={{ delete: remove }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete Collection' }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }))
  );
  expect(remove).toHaveBeenCalledWith(collection.id);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(onSetDeleted).not.toHaveBeenCalled();
});
