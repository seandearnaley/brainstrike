import type { FileChunk } from '@brainstrike/db';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChunksView } from '../database-demo/components/chunks-view';
import { setActiveEmbeddingSetId } from '../vector-preferences';

function makeChunk(overrides: Partial<FileChunk> = {}): FileChunk {
  return {
    id: 'c1',
    chunkType: 'text',
    chunkIndex: 0,
    tokenCount: 10,
    createdAt: '2025-01-01T00:00:00Z',
    content: 'hello world content',
    fileRecordId: 'f1',
    ...overrides,
  };
}

const records = [{ id: 'f1', name: 'file-a.txt' }];

describe('ChunksView', () => {
  it('renders empty state when no chunks', () => {
    render(<ChunksView chunks={[]} records={[]} />);
    expect(
      screen.getByText(
        'No chunks available. Enable chunking in import settings and import some files.'
      )
    ).toBeInTheDocument();
  });

  it('shows pending embedding badge when chunk is pending', () => {
    const chunk = makeChunk();
    render(<ChunksView chunks={[chunk]} records={records} pendingChunkIds={new Set([chunk.id])} />);
    expect(screen.getByText(/embedding pending/i)).toBeInTheDocument();
  });

  it('shows no embedding badge when not pending and no embedding', () => {
    const chunk = makeChunk();
    render(<ChunksView chunks={[chunk]} records={records} />);
    expect(screen.getByText(/no embedding/i)).toBeInTheDocument();
  });

  it('indicates selected set when embedding matches active set id', async () => {
    setActiveEmbeddingSetId('set-1');
    const chunk = makeChunk({ embedding: Array(40).fill(0.1), embeddingSetId: 'set-1' });
    render(<ChunksView chunks={[chunk]} records={records} />);
    expect(screen.getByText(/embedded/i)).toBeInTheDocument();
    expect(screen.getByText(/selected set/i)).toBeInTheDocument();

    const user = userEvent.setup();
    // Toggle shows vector preview
    await user.click(screen.getByRole('button', { name: /view vector/i }));
    expect(screen.getByText(/dims\)/i)).toBeInTheDocument();
    // Toggle hides
    await user.click(screen.getByRole('button', { name: /hide vector/i }));
  });

  it('indicates other set when embedding from different set id', () => {
    setActiveEmbeddingSetId('set-2');
    const chunk = makeChunk({ embedding: [0.1, 0.2, 0.3], embeddingSetId: 'set-1' });
    render(<ChunksView chunks={[chunk]} records={records} />);
    expect(screen.getByText(/other set/i)).toBeInTheDocument();
  });
});
