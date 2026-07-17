import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CollectionBrowser } from '../collection-browser/collection-browser';
import type { CollectionBrowserFilters } from '../collection-browser/types';

function makeFilters(overrides: Partial<CollectionBrowserFilters> = {}): CollectionBrowserFilters {
  return {
    embeddingStatus: 'all',
    nodeTypes: new Set(['collection', 'file', 'chunk', 'embedding']),
    searchMatchesOnly: false,
    searchQuery: '',
    ...overrides,
  };
}

describe('CollectionBrowser', () => {
  it('renders embedding status as a compact icon column instead of text badges', () => {
    render(
      <CollectionBrowser
        data={{
          chunks: [
            {
              chunkIndex: 0,
              fileRecordId: 'file-1',
              hasEmbedding: true,
              id: 'chunk-1',
              tokenCount: 42,
            },
          ],
          files: [
            {
              chunksCount: 1,
              embeddedChunksCount: 1,
              id: 'file-1',
              name: 'indexed.ts',
              path: '/project/indexed.ts',
              size: 512,
            },
          ],
        }}
      />
    );

    const statusHeader = screen.getByRole('columnheader', { name: 'Status' });
    expect(statusHeader).toHaveStyle({ minWidth: '44px', width: '44px' });
    expect(screen.getByLabelText('Complete embedding status')).toBeInTheDocument();
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('keeps collection browser wrappers shrinkable in narrow layouts', () => {
    const { container } = render(<CollectionBrowser data={{ chunks: [], files: [] }} />);

    const root = container.firstElementChild;
    expect(root).toHaveClass('min-w-0');

    expect(screen.getByTestId('collection-tree-region')).toHaveClass('min-w-0');
  });

  it('renders loading overlay without unmounting the tree region', () => {
    render(<CollectionBrowser data={{ chunks: [], files: [] }} isLoading={true} />);
    expect(screen.getByTestId('collection-tree-region')).toBeInTheDocument();
    expect(screen.getByTestId('collection-tree-region')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows semantic empty state when a semantic search has been executed', () => {
    render(
      <CollectionBrowser
        data={{ chunks: [], files: [] }}
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
    render(<CollectionBrowser data={{ chunks: [], files: [] }} searchMode="quick" />);
    expect(
      screen.getByText(/No collections found\. Import files to get started\./i)
    ).toBeInTheDocument();
  });
});
