import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchCollectionSelector } from '../search-collection-selector';

const mockToast = vi.fn();
const mockUseCollections = vi.fn();

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/ui')>('@brainstrike/ui');
  return {
    ...actual,
    ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
    CollectionPicker: ({
      collections,
      loading,
      onCreate,
      onDelete,
      onEdit,
      onSelect,
      selectedId,
    }: {
      collections: Array<{
        canDelete?: boolean;
        canEdit?: boolean;
        canNormalSearchSelect?: boolean;
        id: string;
        name: string | null;
        systemRole?: 'workspace-index' | null;
      }>;
      loading: boolean;
      onCreate: () => void;
      onDelete: (collection: { id: string; name: string | null }) => void;
      onEdit: (collection: { id: string; name: string | null }) => void;
      onSelect: (id: string | null) => void;
      selectedId: string | null;
    }) => (
      <div>
        <div data-testid="loading-state">{loading ? 'loading' : 'ready'}</div>
        <button onClick={onCreate} type="button">
          Create collection
        </button>
        {collections.map((collection) => (
          <div key={collection.id}>
            <button onClick={() => onSelect(collection.id)} type="button">
              {collection.name ?? collection.id}
            </button>
            <button onClick={() => onEdit(collection)} type="button">
              edit-{collection.id}
            </button>
            <button onClick={() => onDelete(collection)} type="button">
              delete-{collection.id}
            </button>
            {selectedId === collection.id ? (
              <span data-testid="selected-id">{collection.id}</span>
            ) : null}
          </div>
        ))}
      </div>
    ),
    useToast: () => ({ toast: mockToast }),
  };
});

vi.mock('@brainstrike/vector-management', () => ({
  useCollections: (...args: unknown[]) => mockUseCollections(...args),
}));

describe('SearchCollectionSelector', () => {
  beforeEach(() => {
    mockToast.mockReset();
    mockUseCollections.mockReset();
    mockUseCollections.mockReturnValue({
      collections: [
        {
          id: 'set-1',
          name: 'Collection One',
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2024-01-01T00:00:00Z',
          description: null,
          tags: null,
          category: null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
        },
      ],
      loading: false,
      error: null,
    });
  });

  it('renders collections from the shared hook and reports the selected id', () => {
    render(
      <SearchCollectionSelector
        activeCollectionId="set-1"
        db={{} as never}
        onCollectionChange={vi.fn()}
        onCreateCollection={vi.fn()}
        onDeleteCollection={vi.fn()}
        onEditCollection={vi.fn()}
      />
    );

    expect(screen.getByText('Collection One')).toBeInTheDocument();
    expect(screen.getByTestId('selected-id')).toHaveTextContent('set-1');
  });

  it('wires create, edit, delete, and select actions through to the parent callbacks', async () => {
    const user = userEvent.setup();
    const onCollectionChange = vi.fn();
    const onCreateCollection = vi.fn();
    const onDeleteCollection = vi.fn();
    const onEditCollection = vi.fn();

    render(
      <SearchCollectionSelector
        activeCollectionId={null}
        db={{} as never}
        onCollectionChange={onCollectionChange}
        onCreateCollection={onCreateCollection}
        onDeleteCollection={onDeleteCollection}
        onEditCollection={onEditCollection}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create collection' }));
    await user.click(screen.getByRole('button', { name: 'Collection One' }));
    await user.click(screen.getByRole('button', { name: 'edit-set-1' }));
    await user.click(screen.getByRole('button', { name: 'delete-set-1' }));

    expect(onCreateCollection).toHaveBeenCalledTimes(1);
    expect(onCollectionChange).toHaveBeenCalledWith('set-1');
    expect(onEditCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 'set-1' }));
    expect(onDeleteCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 'set-1' }));
  });

  it('refuses workspace index selection and collection mutations', async () => {
    const user = userEvent.setup();
    const onCollectionChange = vi.fn();
    const onDeleteCollection = vi.fn();
    const onEditCollection = vi.fn();
    mockUseCollections.mockReturnValue({
      collections: [
        {
          id: 'workspace-index',
          name: 'Workspace Index',
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2026-06-07T00:00:00Z',
          description: null,
          tags: null,
          category: null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
          systemRole: 'workspace-index',
        },
      ],
      loading: false,
      error: null,
    });

    render(
      <SearchCollectionSelector
        activeCollectionId="workspace-index"
        db={{} as never}
        onCollectionChange={onCollectionChange}
        onCreateCollection={vi.fn()}
        onDeleteCollection={onDeleteCollection}
        onEditCollection={onEditCollection}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Workspace Index' }));
    await user.click(screen.getByRole('button', { name: 'edit-workspace-index' }));
    await user.click(screen.getByRole('button', { name: 'delete-workspace-index' }));

    expect(screen.queryByTestId('selected-id')).toBeNull();
    expect(onCollectionChange).not.toHaveBeenCalled();
    expect(onEditCollection).not.toHaveBeenCalled();
    expect(onDeleteCollection).not.toHaveBeenCalled();
  });

  it('keeps edit and delete actions available when only search selection is disabled', async () => {
    const user = userEvent.setup();
    const onCollectionChange = vi.fn();
    const onDeleteCollection = vi.fn();
    const onEditCollection = vi.fn();
    mockUseCollections.mockReturnValue({
      collections: [
        {
          id: 'curated-set',
          name: 'Curated Set',
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2026-06-07T00:00:00Z',
          description: null,
          tags: null,
          category: null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
          canNormalSearchSelect: false,
          canEdit: true,
          canDelete: true,
        },
      ],
      loading: false,
      error: null,
    });

    render(
      <SearchCollectionSelector
        activeCollectionId="curated-set"
        db={{} as never}
        onCollectionChange={onCollectionChange}
        onCreateCollection={vi.fn()}
        onDeleteCollection={onDeleteCollection}
        onEditCollection={onEditCollection}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Curated Set' }));
    await user.click(screen.getByRole('button', { name: 'edit-curated-set' }));
    await user.click(screen.getByRole('button', { name: 'delete-curated-set' }));

    expect(screen.queryByTestId('selected-id')).toBeNull();
    expect(onCollectionChange).not.toHaveBeenCalled();
    expect(onEditCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 'curated-set' }));
    expect(onDeleteCollection).toHaveBeenCalledWith(expect.objectContaining({ id: 'curated-set' }));
  });

  it('surfaces collection-loading state without dropping existing collections', () => {
    mockUseCollections.mockReturnValue({
      collections: [
        {
          id: 'set-optimistic',
          name: 'Optimistic Collection',
          modelKey: 'openai::text-embedding-3-small',
          modelId: 'text-embedding-3-small',
          dimensions: 1536,
          distance: 'cosine',
          createdAt: '2024-01-02T00:00:00Z',
          description: null,
          tags: null,
          category: null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
        },
      ],
      loading: true,
      error: null,
    });

    render(
      <SearchCollectionSelector
        activeCollectionId="set-optimistic"
        db={{} as never}
        onCollectionChange={vi.fn()}
        onCreateCollection={vi.fn()}
        onDeleteCollection={vi.fn()}
        onEditCollection={vi.fn()}
      />
    );

    expect(screen.getByTestId('loading-state')).toHaveTextContent('loading');
    expect(screen.getByText('Optimistic Collection')).toBeInTheDocument();
  });
});
