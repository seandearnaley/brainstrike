/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CollectionSelect,
  type CollectionWithDocCount,
} from '../collection-select/collection-select';

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteLiveQuery: vi.fn(() => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    rows: [],
  })),
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
});
