import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionEmbeddingCoverageSnapshot } from '../../hooks/use-collection-embedding-coverage';
import { CollectionEmbeddingCoverageBanner } from '../embedding-coverage-notice';

// Drive the live-query hook with a controllable snapshot so the test exercises
// the real store -> wrapper -> presentational DOM wiring (only the DB read is
// stubbed, which is unavailable without a DbProvider).
let mockSnapshot: CollectionEmbeddingCoverageSnapshot;

vi.mock('../../hooks/use-collection-embedding-coverage', () => ({
  useCollectionEmbeddingCoverage: () => ({
    snapshot: mockSnapshot,
    error: null,
    loading: false,
  }),
}));

const STALE_SNAPSHOT: CollectionEmbeddingCoverageSnapshot = {
  status: 'needs_reindex',
  pendingReindexFileCount: 17,
  chunksMissingSourceRange: 0,
  totalFiles: 17,
  totalChunks: 0,
};

describe('CollectionEmbeddingCoverageBanner (store-driven DOM)', () => {
  beforeEach(() => {
    __resetVectorStatusUIStoreForTests();
    mockSnapshot = STALE_SNAPSHOT;
  });

  afterEach(() => {
    __resetVectorStatusUIStoreForTests();
  });

  it('shows the stable indexing note (not the flicker-prone re-index alarm) while the collection is indexing', () => {
    act(() => {
      useVectorStatusUIStore.getState().setActiveEmbeddingSetId('col-1');
      useVectorStatusUIStore.getState().setIsImporting(true);
    });

    render(
      <CollectionEmbeddingCoverageBanner activeCollectionId="col-1" activeCollectionName="Docs" />
    );

    const notice = screen.getByTestId('embedding-coverage-notice');
    expect(notice).toHaveAttribute('data-coverage-status', 'indexing');
    expect(screen.queryByText(/needs re-indexing/i)).not.toBeInTheDocument();
    // Count-free text => no per-file churn => no layout shift.
    expect(notice).not.toHaveTextContent(/\d/);
  });

  it('shows the re-index guidance once indexing is idle and the collection is genuinely stale', () => {
    render(
      <CollectionEmbeddingCoverageBanner activeCollectionId="col-1" activeCollectionName="Docs" />
    );

    expect(screen.getByText(/needs re-indexing/i)).toBeInTheDocument();
    expect(screen.getByText(/17 files/i)).toBeInTheDocument();
    expect(screen.getByTestId('embedding-coverage-notice')).toHaveAttribute(
      'data-coverage-status',
      'needs_reindex'
    );
  });

  it('does not claim a different collection is indexing', () => {
    act(() => {
      // A different collection is the indexing target.
      useVectorStatusUIStore.getState().setActiveEmbeddingSetId('col-2');
      useVectorStatusUIStore.getState().setIsImporting(true);
    });

    render(
      <CollectionEmbeddingCoverageBanner activeCollectionId="col-1" activeCollectionName="Docs" />
    );

    // The displayed (idle) collection still shows its genuine stale warning.
    expect(screen.getByText(/needs re-indexing/i)).toBeInTheDocument();
  });
});
