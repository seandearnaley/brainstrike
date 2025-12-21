import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionPicker } from '../collection-picker';
import type { CollectionPickerCollection } from '../collection-picker/types';

vi.mock('../collection-picker/hooks/use-resolved-theme', () => ({
  useResolvedTheme: () => 'light' as const,
}));

function createCollection(
  overrides: Partial<CollectionPickerCollection> = {}
): CollectionPickerCollection {
  return {
    id: 'c-1',
    modelKey: 'openai::text-embedding-3-small',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
    distance: 'cosine',
    createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    name: 'My Collection',
    description: null,
    tags: null,
    category: null,
    fileCount: 2,
    chunkCount: 10,
    embeddingCount: 7,
    ...overrides,
  };
}

describe('CollectionPicker', () => {
  it('shows loading state', () => {
    render(
      <CollectionPicker
        collections={[]}
        loading
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={vi.fn()}
        selectedId={null}
      />
    );

    expect(screen.getByText('Loading collections...')).toBeInTheDocument();
  });

  it('renders empty state with header and create action', () => {
    const onCreate = vi.fn();
    render(
      <CollectionPicker
        collections={[]}
        headerLabel="Search Collection"
        onCreate={onCreate}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={vi.fn()}
        selectedId={null}
        showHeader
      />
    );

    expect(screen.getByText('Search Collection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create First Collection' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders listbox with aria-label', () => {
    render(
      <CollectionPicker
        collections={[createCollection()]}
        headerLabel="Collections"
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={vi.fn()}
        selectedId={null}
      />
    );

    expect(screen.getByRole('listbox', { name: 'Collections' })).toBeInTheDocument();
  });

  it('selects and deselects on repeated click', () => {
    const onSelect = vi.fn();
    const collection = createCollection({ id: 'c-1', name: 'Alpha' });

    const { rerender } = render(
      <CollectionPicker
        collections={[collection]}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={onSelect}
        selectedId={null}
      />
    );

    const option = screen.getByRole('option', { name: /alpha/i });
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledWith('c-1');

    // simulate parent updating selectedId -> allows toggle-to-null behavior
    rerender(
      <CollectionPicker
        collections={[collection]}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={onSelect}
        selectedId="c-1"
      />
    );

    fireEvent.click(screen.getByRole('option', { name: /alpha/i }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('does not select when clicking edit/delete buttons', () => {
    const onSelect = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const collection = createCollection({ id: 'c-1', name: 'Alpha' });

    render(
      <CollectionPicker
        collections={[collection]}
        onCreate={vi.fn()}
        onDelete={onDelete}
        onEdit={onEdit}
        onSelect={onSelect}
        selectedId={null}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('supports keyboard navigation between options', () => {
    const onSelect = vi.fn();
    const collections = [
      createCollection({ id: 'c-1', name: 'Alpha' }),
      createCollection({ id: 'c-2', name: 'Beta' }),
      createCollection({ id: 'c-3', name: 'Gamma' }),
    ];

    render(
      <CollectionPicker
        collections={collections}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onSelect={onSelect}
        selectedId={null}
      />
    );

    const alpha = screen.getByRole('option', { name: /alpha/i });
    const beta = screen.getByRole('option', { name: /beta/i });
    const gamma = screen.getByRole('option', { name: /gamma/i });

    alpha.focus();
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(beta);

    fireEvent.keyDown(beta, { key: 'End' });
    expect(document.activeElement).toBe(gamma);

    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c-1');
  });
});
