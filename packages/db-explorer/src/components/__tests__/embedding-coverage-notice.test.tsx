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
    backfillEmbeddingSetId: null,
    collectionId: 'col-1',
    managedCollectionId: 'col-1',
    syncState: 'idle' as const,
  };

  it('is false when the managed collection is idle', () => {
    expect(isCollectionIndexingActive(base)).toBe(false);
  });

  it.each([
    'scanning',
    'importing',
    'chunking',
    'embedding',
    'recovering',
  ] as const)('is true while the managed collection is %s', (syncState) => {
    expect(isCollectionIndexingActive({ ...base, syncState })).toBe(true);
  });

  it('is false when a DIFFERENT collection is the managed/indexing target', () => {
    // Reproduces the reported bug: switching to col-1 while col-2 indexes.
    expect(
      isCollectionIndexingActive({ ...base, managedCollectionId: 'col-2', syncState: 'embedding' })
    ).toBe(false);
  });

  it('is true while a backfill is in flight for the displayed collection', () => {
    expect(
      isCollectionIndexingActive({
        ...base,
        managedCollectionId: null,
        backfillEmbeddingSetId: 'col-1',
        syncState: 'idle',
      })
    ).toBe(true);
  });

  it('is false when a backfill targets a different collection', () => {
    expect(
      isCollectionIndexingActive({
        ...base,
        managedCollectionId: null,
        backfillEmbeddingSetId: 'col-2',
        syncState: 'idle',
      })
    ).toBe(false);
  });

  it('is false when the managed collection is paused or errored', () => {
    expect(isCollectionIndexingActive({ ...base, syncState: 'paused' })).toBe(false);
    expect(isCollectionIndexingActive({ ...base, syncState: 'error' })).toBe(false);
  });

  it('is false when there is no displayed collection', () => {
    expect(
      isCollectionIndexingActive({ ...base, syncState: 'importing', collectionId: null })
    ).toBe(false);
  });
});
