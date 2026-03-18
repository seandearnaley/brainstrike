import type { IEmbeddingSetsRepository } from '@brainstrike/db';
import { Toaster } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameEmbeddingSetDialog } from '../embedding-set-management/rename-embedding-set-dialog';

const dispatchEmbeddingSetUpdated = vi.fn();

vi.mock('../collection-select/embedding-set-events', () => ({
  dispatchEmbeddingSetUpdated: (...args: unknown[]) => dispatchEmbeddingSetUpdated(...args),
}));

describe('RenameEmbeddingSetDialog', () => {
  const mockOnOpenChange = vi.fn();
  const mockOnSetRenamed = vi.fn();
  const mockRepository = {
    updateMetadata: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEmbeddingSetsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves file, chunk, and embedding counts in the update event payload', async () => {
    const user = userEvent.setup();

    render(
      <>
        <Toaster />
        <RenameEmbeddingSetDialog
          embeddingSet={{
            id: 'set-1',
            modelKey: 'openai::text-embedding-3-small',
            modelId: 'text-embedding-3-small',
            dimensions: 1536,
            distance: 'cosine',
            createdAt: '2024-01-01T00:00:00Z',
            name: 'Original Name',
            description: 'Original description',
            tags: 'code',
            category: 'dev',
            fileCount: 12,
            chunkCount: 240,
            embeddingCount: 180,
          }}
          onOpenChange={mockOnOpenChange}
          onSetRenamed={mockOnSetRenamed}
          open={true}
          repository={mockRepository}
        />
      </>
    );

    await user.clear(screen.getByLabelText(/Name/i));
    await user.type(screen.getByLabelText(/Name/i), 'Renamed Collection');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(dispatchEmbeddingSetUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'set-1',
          reason: 'updated',
          collection: expect.objectContaining({
            id: 'set-1',
            name: 'Renamed Collection',
            fileCount: 12,
            chunkCount: 240,
            embeddingCount: 180,
          }),
        })
      );
    });
  });
});
