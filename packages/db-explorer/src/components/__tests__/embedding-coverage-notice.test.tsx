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

    expect(screen.getByText(/5 chunks missing source ranges/i)).toBeInTheDocument();
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

    // Compact single-line copy: "Fully indexed · 40 chunks / 4 files"
    const notice = screen.getByTestId('embedding-coverage-notice');
    expect(notice).toHaveTextContent(/fully indexed/i);
    expect(notice).toHaveTextContent(/40 chunks/i);
    expect(notice).toHaveTextContent(/4 files/i);
  });

  it('singularizes the fully-indexed copy for a single chunk/file', () => {
    render(
      <EmbeddingCoverageNotice
        collectionName="Solo"
        coverage={{ ...baseCoverage, status: 'fully_indexed', totalFiles: 1, totalChunks: 1 }}
      />
    );

    const notice = screen.getByTestId('embedding-coverage-notice');
    expect(notice).toHaveTextContent('1 chunk / 1 file');
    expect(notice).not.toHaveTextContent(/1 chunks/);
    expect(notice).not.toHaveTextContent(/1 files/);
  });

  it('renders the coverage notice as a single flat line that can truncate (min-w-0)', () => {
    render(
      <EmbeddingCoverageNotice
        collectionName="Stable"
        coverage={{ ...baseCoverage, status: 'fully_indexed', totalFiles: 4, totalChunks: 40 }}
      />
    );

    const notice = screen.getByTestId('embedding-coverage-notice');
    // Flat row: no rounded "card" chrome (border/background/heavy padding).
    expect(notice.className).not.toMatch(/\brounded-md\b/);
    expect(notice.className).not.toMatch(/\bborder\b/);
    expect(notice.className).toMatch(/\bitems-center\b/);
    // The message span must carry min-w-0 or `truncate` is a no-op in a flex row.
    const messageSpan = screen.getByText(/fully indexed/i);
    expect(messageSpan).toHaveClass('truncate');
    expect(messageSpan).toHaveClass('min-w-0');
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
    managedCollectionId: 'col-1',
    syncState: 'idle' as const,
  };

  it('is false when the managed collection is idle (settled — no stuck spinner)', () => {
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

  it.each([
    'idle',
    'waiting',
    'paused',
    'error',
    'disabled',
  ] as const)('is false once the managed collection settles to %s (clears on its own)', (syncState) => {
    expect(isCollectionIndexingActive({ ...base, syncState })).toBe(false);
  });

  it('is false when there is no managed collection even if some state is active', () => {
    expect(
      isCollectionIndexingActive({ ...base, managedCollectionId: null, syncState: 'embedding' })
    ).toBe(false);
  });

  it('is false when there is no displayed collection', () => {
    expect(
      isCollectionIndexingActive({ ...base, syncState: 'importing', collectionId: null })
    ).toBe(false);
  });
});
