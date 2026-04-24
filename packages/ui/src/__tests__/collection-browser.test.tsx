import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CollectionBrowser } from '../collection-browser/collection-browser';
import type { CollectionBrowserFilters } from '../collection-browser/types';

function makeFilters(overrides: Partial<CollectionBrowserFilters> = {}): CollectionBrowserFilters {
  return {
    searchQuery: '',
    nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
    embeddingStatus: 'all',
    searchMatchesOnly: false,
    ...overrides,
  };
}

describe('CollectionBrowser', () => {
  it('renders embedding status as a compact icon column instead of text badges', () => {
    render(
      <CollectionBrowser
        data={{
          files: [
            {
              id: 'file-1',
              name: 'indexed.ts',
              path: '/project/indexed.ts',
              size: 512,
              chunksCount: 1,
              embeddedChunksCount: 1,
            },
          ],
          chunks: [
            {
              id: 'chunk-1',
              fileRecordId: 'file-1',
              chunkIndex: 0,
              tokenCount: 42,
              hasEmbedding: true,
            },
          ],
        }}
      />
    );

    const statusHeader = screen.getByRole('columnheader', { name: 'Status' });
    expect(statusHeader).toHaveStyle({ width: '44px', minWidth: '44px' });
    expect(screen.getByLabelText('Complete embedding status')).toBeInTheDocument();
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('keeps collection browser wrappers shrinkable in narrow layouts', () => {
    const { container } = render(<CollectionBrowser data={{ files: [], chunks: [] }} />);

    const root = container.firstElementChild;
    expect(root).toHaveClass('min-w-0');

    expect(screen.getByTestId('collection-tree-region')).toHaveClass('min-w-0');
  });

  it('renders loading overlay without unmounting the tree region', () => {
    render(<CollectionBrowser data={{ files: [], chunks: [] }} isLoading={true} />);
    expect(screen.getByTestId('collection-tree-region')).toBeInTheDocument();
    expect(screen.getByTestId('collection-tree-region')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows semantic empty state when a semantic search has been executed', () => {
    render(
      <CollectionBrowser
        data={{ files: [], chunks: [] }}
        filters={makeFilters()}
        hasSearched={true}
        searchMode="semantic"
        semanticResults={[]}
      />
    );

    expect(
      screen.getByText(
        /No matching results found\. Try adjusting your search query or threshold\./i
      )
    ).toBeInTheDocument();
  });

  it('shows default empty message in quick mode', () => {
    render(<CollectionBrowser data={{ files: [], chunks: [] }} searchMode="quick" />);
    expect(
      screen.getByText(/No collections found\. Import files to get started\./i)
    ).toBeInTheDocument();
  });
});
