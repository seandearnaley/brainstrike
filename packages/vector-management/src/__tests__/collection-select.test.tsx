/**
 * @vitest-environment jsdom
 */
import type { EmbeddingSpaceListing } from '@brainstrike/db';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CollectionSelect,
  type CollectionWithDocCount,
} from '../collection-select/collection-select';

const mockEmbeddingSetsRepository = {
  listEmbeddingSpaces: vi.fn<() => Promise<EmbeddingSpaceListing[]>>(async () => []),
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: vi.fn(() => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    rows: [],
  })),
  useEmbeddingSetsRepository: vi.fn(() => mockEmbeddingSetsRepository),
  useOptionalPGliteDatabase: vi.fn(() => null),
}));

const mockStoreState = {
  isImporting: false,
  schemaVerified: false,
  cachedCollections: [] as CollectionWithDocCount[],
  setCachedCollections: vi.fn((collections: CollectionWithDocCount[]) => {
    mockStoreState.cachedCollections = collections;
  }),
  upsertCachedCollection: vi.fn(),
  removeCachedCollection: vi.fn(),
};

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  compareCollectionsDesc: vi.fn((left: CollectionWithDocCount, right: CollectionWithDocCount) =>
    right.createdAt.localeCompare(left.createdAt)
  ),
  useVectorStatusUIStore: vi.fn((selector: (state: typeof mockStoreState) => unknown) =>
    selector(mockStoreState)
  ),
}));

const workspaceIndexCollection: CollectionWithDocCount = {
  id: 'workspace-index',
  modelKey: 'openai::text-embedding-3-small',
  modelId: 'text-embedding-3-small',
  dimensions: 1536,
  distance: 'cosine',
  createdAt: '2026-06-07T00:00:00Z',
  name: 'Workspace Index',
  description: 'System-managed workspace index for assistant retrieval.',
  tags: null,
  category: null,
  fileCount: 42,
  chunkCount: 420,
  embeddingCount: 300,
  systemRole: 'workspace-index',
};

const userCollection: CollectionWithDocCount = {
  id: 'user-collection',
  modelKey: 'openai::text-embedding-3-small',
  modelId: 'text-embedding-3-small',
  dimensions: 1536,
  distance: 'cosine',
  createdAt: '2026-06-06T00:00:00Z',
  name: 'User Collection',
  description: null,
  tags: null,
  category: null,
  fileCount: 7,
  chunkCount: 70,
  embeddingCount: 70,
  systemRole: null,
};

describe('CollectionSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoreState.isImporting = false;
    mockStoreState.schemaVerified = false;
    mockStoreState.cachedCollections = [];
    mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([]);
  });

  it('does not display the protected workspace index as the selected normal collection', () => {
    render(
      <CollectionSelect
        collections={[workspaceIndexCollection, userCollection]}
        onSelectionChange={vi.fn()}
        placeholder="Select collection"
        selectedId={workspaceIndexCollection.id}
      />
    );

    expect(screen.getByRole('combobox')).toHaveTextContent('Select collection');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('Workspace Index');
  });

  it('does not mask repository-loaded Turso collections behind the loading state when db is null', async () => {
    mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([
      {
        category: 'search',
        createdAt: '2024-01-01T00:00:00Z',
        description: null,
        dimensions: 1536,
        distance: 'cosine',
        id: 'turso-set-1',
        modelId: 'text-embedding-3-small',
        modelKey: 'openai::text-embedding-3-small',
        name: 'Turso Collection',
        stats: {
          averageTokensPerChunk: 5,
          embeddedChunks: 7,
          fileCount: 3,
          tokenizedChunkCount: 8,
          totalChunks: 9,
          totalTokens: 45,
        },
        systemRole: null,
        tags: null,
      },
    ]);

    render(
      <CollectionSelect
        db={null}
        onSelectionChange={vi.fn()}
        placeholder="Select collection"
        selectedId="turso-set-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveTextContent('Turso Collection (3 files');
    });
    expect(screen.getByRole('combobox')).not.toBeDisabled();
    expect(screen.getByRole('combobox')).not.toHaveTextContent('Loading...');
  });

  it('shows the empty state after an empty Turso repository snapshot when db is null', async () => {
    mockEmbeddingSetsRepository.listEmbeddingSpaces.mockResolvedValue([]);

    render(
      <CollectionSelect
        db={null}
        emptyState={<div>No embedding sets yet</div>}
        onSelectionChange={vi.fn()}
        placeholder="Select collection"
        selectedId={null}
      />
    );

    await waitFor(() => {
      expect(mockEmbeddingSetsRepository.listEmbeddingSpaces).toHaveBeenCalledWith({
        includeStats: true,
      });
    });

    expect(screen.getByText('No embedding sets yet')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
