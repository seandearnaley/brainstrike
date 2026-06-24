import type { IEmbeddingSetsRepository } from '@brainstrike/db';
import { Toaster } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteEmbeddingSetDialog } from '../embedding-set-management/delete-embedding-set-dialog';

const dispatchEmbeddingSetUpdated = vi.fn();

vi.mock('../collection-select/embedding-set-events', () => ({
  dispatchEmbeddingSetUpdated: (...args: unknown[]) => dispatchEmbeddingSetUpdated(...args),
}));

describe('DeleteEmbeddingSetDialog', () => {
  const mockOnOpenChange = vi.fn();
  const mockOnSetDeleted = vi.fn();
  const mockRepository = {
    delete: vi.fn().mockResolvedValue(true),
  } as unknown as IEmbeddingSetsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes through the embedding set repository instead of raw database SQL', async () => {
    const user = userEvent.setup();

    render(
      <>
        <Toaster />
        <DeleteEmbeddingSetDialog
          embeddingSet={{
            id: 'set-1',
            modelKey: 'openai::text-embedding-3-small',
            modelId: 'text-embedding-3-small',
            dimensions: 1536,
            distance: 'cosine',
            createdAt: '2024-01-01T00:00:00Z',
            name: 'Docs',
            chunkCount: 24,
          }}
          onOpenChange={mockOnOpenChange}
          onSetDeleted={mockOnSetDeleted}
          open={true}
          repository={mockRepository}
        />
      </>
    );

    await user.click(screen.getByRole('button', { name: 'Delete Collection' }));

    await waitFor(() => {
      expect(mockRepository.delete).toHaveBeenCalledWith('set-1');
    });
    expect(dispatchEmbeddingSetUpdated).toHaveBeenCalledWith({
      id: 'set-1',
      reason: 'deleted',
    });
    expect(mockOnSetDeleted).toHaveBeenCalledWith('set-1');
  });

  it('does not emit deleted side effects when the repository reports a missing collection', async () => {
    const user = userEvent.setup();
    const missingRepository = {
      delete: vi.fn().mockResolvedValue(false),
    } as unknown as IEmbeddingSetsRepository;

    render(
      <>
        <Toaster />
        <DeleteEmbeddingSetDialog
          embeddingSet={{
            id: 'missing-set',
            modelKey: 'openai::text-embedding-3-small',
            modelId: 'text-embedding-3-small',
            dimensions: 1536,
            distance: 'cosine',
            createdAt: '2024-01-01T00:00:00Z',
            name: 'Missing Docs',
            chunkCount: 0,
          }}
          onOpenChange={mockOnOpenChange}
          onSetDeleted={mockOnSetDeleted}
          open={true}
          repository={missingRepository}
        />
      </>
    );

    await user.click(screen.getByRole('button', { name: 'Delete Collection' }));

    await waitFor(() => {
      expect(missingRepository.delete).toHaveBeenCalledWith('missing-set');
    });
    expect(dispatchEmbeddingSetUpdated).not.toHaveBeenCalled();
    expect(mockOnSetDeleted).not.toHaveBeenCalled();
    expect(mockOnOpenChange).not.toHaveBeenCalledWith(false);
  });
});
