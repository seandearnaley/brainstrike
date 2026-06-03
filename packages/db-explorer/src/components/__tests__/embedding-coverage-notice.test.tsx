import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollectionEmbeddingCoverageSnapshot } from '../../hooks/use-collection-embedding-coverage';
import { EmbeddingCoverageNotice, isCollectionIndexingActive } from '../embedding-coverage-notice';

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

  it('suppresses the re-index alarm and shows a stable indexing note while indexing is active', () => {
    render(
      <EmbeddingCoverageNotice
        collectionName="Docs"
        coverage={{
          ...baseCoverage,
          status: 'needs_reindex',
          pendingReindexFileCount: 17,
          totalFiles: 17,
        }}
        indexingActive
      />
    );

    const notice = screen.getByTestId('embedding-coverage-notice');
    expect(notice).toHaveAttribute('data-coverage-status', 'indexing');
    // The alarming, churn-prone re-index wording must NOT appear during indexing.
    expect(screen.queryByText(/needs re-indexing/i)).not.toBeInTheDocument();
    // No per-file count is rendered, so the message text stays stable (no layout shift).
    expect(notice).not.toHaveTextContent(/\d/);
    expect(screen.getByText(/indexing/i)).toBeInTheDocument();
  });

  it('shows the indexing note even before any files are recorded', () => {
    render(
      <EmbeddingCoverageNotice collectionName="Fresh" coverage={baseCoverage} indexingActive />
    );

    const notice = screen.getByTestId('embedding-coverage-notice');
    expect(notice).toHaveAttribute('data-coverage-status', 'indexing');
    expect(screen.getByText(/indexing/i)).toBeInTheDocument();
  });
});

describe('isCollectionIndexingActive', () => {
  const base = {
    collectionId: 'col-1',
    indexingTargetId: 'col-1',
    isImporting: false,
    isEmbeddingActive: false,
  };

  it('is false when nothing is running', () => {
    expect(isCollectionIndexingActive(base)).toBe(false);
  });

  it('is true while importing the displayed collection', () => {
    expect(isCollectionIndexingActive({ ...base, isImporting: true })).toBe(true);
  });

  it('is true while embedding the displayed collection', () => {
    expect(isCollectionIndexingActive({ ...base, isEmbeddingActive: true })).toBe(true);
  });

  it('is false when a different collection is the indexing target', () => {
    expect(
      isCollectionIndexingActive({ ...base, isEmbeddingActive: true, indexingTargetId: 'col-2' })
    ).toBe(false);
  });

  it('falls back to active when the indexing target is unknown', () => {
    expect(isCollectionIndexingActive({ ...base, isImporting: true, indexingTargetId: null })).toBe(
      true
    );
  });

  it('is false when there is no displayed collection', () => {
    expect(isCollectionIndexingActive({ ...base, isImporting: true, collectionId: null })).toBe(
      false
    );
  });
});
