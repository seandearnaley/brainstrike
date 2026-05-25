import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollectionEmbeddingCoverageSnapshot } from '../../hooks/use-collection-embedding-coverage';
import { EmbeddingCoverageNotice } from '../embedding-coverage-notice';

const baseCoverage: CollectionEmbeddingCoverageSnapshot = {
  pendingReindexFileCount: 0,
  chunksMissingSourceRange: 0,
  totalFiles: 0,
  totalChunks: 0,
  status: 'idle',
};

describe('EmbeddingCoverageNotice', () => {
  it('renders nothing for idle collections', () => {
    const { container } = render(
      <EmbeddingCoverageNotice collectionName="Docs" coverage={baseCoverage} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows re-index guidance for stale collections', () => {
    render(
      <EmbeddingCoverageNotice
        collectionName="Code"
        coverage={{
          ...baseCoverage,
          status: 'needs_reindex',
          pendingReindexFileCount: 2,
          totalFiles: 2,
        }}
      />
    );

    expect(screen.getByTestId('embedding-coverage-notice')).toHaveAttribute(
      'data-coverage-status',
      'needs_reindex'
    );
    expect(screen.getByText(/needs re-indexing/i)).toBeInTheDocument();
    expect(screen.getByText(/2 files/i)).toBeInTheDocument();
  });

  it('shows partial source-range skip counts', () => {
    render(
      <EmbeddingCoverageNotice
        coverage={{
          ...baseCoverage,
          status: 'partial_source_ranges',
          chunksMissingSourceRange: 5,
          totalFiles: 3,
          totalChunks: 10,
        }}
      />
    );

    expect(screen.getByText(/5 chunks missing source line metadata/i)).toBeInTheDocument();
  });

  it('shows fully indexed state', () => {
    render(
      <EmbeddingCoverageNotice
        collectionName="Stable"
        coverage={{
          ...baseCoverage,
          status: 'fully_indexed',
          totalFiles: 4,
          totalChunks: 40,
        }}
      />
    );

    expect(screen.getByText(/fully indexed with line-aware chunk metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/40 chunks across 4 files/i)).toBeInTheDocument();
  });
});
