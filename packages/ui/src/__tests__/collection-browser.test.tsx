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
  it('renders loading state', () => {
    render(<CollectionBrowser data={{ files: [], chunks: [] }} isLoading={true} />);
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
