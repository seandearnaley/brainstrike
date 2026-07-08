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
  category: null,
  chunkCount: 420,
  createdAt: '2026-06-07T00:00:00Z',
  description: 'System-managed workspace index for assistant retrieval.',
  dimensions: 1536,
  distance: 'cosine',
  embeddingCount: 300,
  fileCount: 42,
  id: 'workspace-index',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
  name: 'Workspace Index',
  systemRole: 'workspace-index',
  tags: null,
};

const userCollection: CollectionWithDocCount = {
  category: null,
  chunkCount: 70,
  createdAt: '2026-06-06T00:00:00Z',
  description: null,
  dimensions: 1536,
  distance: 'cosine',
  embeddingCount: 70,
  fileCount: 7,
  id: 'user-collection',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai::text-embedding-3-small',
  name: 'User Collection',
  systemRole: null,
  tags: null,
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
