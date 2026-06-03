import {
  __resetVectorStatusUIStoreForTests,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  __resetWorkspaceCollectionSyncStatusStoreForTests,
  useWorkspaceCollectionSyncStatusStore,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
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

function setBackgroundIndexing(
  managedCollectionId: string,
  state: 'importing' | 'embedding'
): void {
  act(() => {
    useWorkspaceCollectionSyncStatusStore.getState().setStatus({ managedCollectionId, state });
  });
}

describe('CollectionEmbeddingCoverageBanner (store-driven DOM)', () => {
  beforeEach(() => {
    __resetVectorStatusUIStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
    mockSnapshot = STALE_SNAPSHOT;
  });

  afterEach(() => {
    __resetVectorStatusUIStoreForTests();
    __resetWorkspaceCollectionSyncStatusStoreForTests();
  });

  it('shows the stable indexing note (not the flicker-prone re-index alarm) while the collection is indexing', () => {
    setBackgroundIndexing('col-1', 'importing');

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

  it('does not get stuck on "indexing" when a stale recovered backfill lingers after the job settled', () => {
    // Regression for the overnight stuck spinner: the visible vector-status panel
    // "recovers" a backfill into the shared store and does not always clear it when
    // a background job completes. The banner must follow the authoritative, self-
    // clearing sync state (settled to 'idle'), NOT the lingering backfill signal.
    act(() => {
      useVectorStatusUIStore.getState().setActiveBackfill({
        embeddingSetId: 'col-1',
        requestId: 'recovered:stale',
        progress: null,
      });
      useWorkspaceCollectionSyncStatusStore
        .getState()
        .setStatus({ managedCollectionId: 'col-1', state: 'idle' });
    });

    render(
      <CollectionEmbeddingCoverageBanner activeCollectionId="col-1" activeCollectionName="Docs" />
    );

    expect(screen.queryByText(/is indexing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/needs re-indexing/i)).toBeInTheDocument();
    expect(screen.getByTestId('embedding-coverage-notice')).toHaveAttribute(
      'data-coverage-status',
      'needs_reindex'
    );
  });

  it('does not claim the displayed collection is indexing when a DIFFERENT collection is the indexer target', () => {
    // The reported regression: col-2 is being indexed, user switches to col-1.
    setBackgroundIndexing('col-2', 'embedding');

    render(
      <CollectionEmbeddingCoverageBanner activeCollectionId="col-1" activeCollectionName="Docs" />
    );

    // The displayed (idle, stale) collection shows its genuine warning, not "indexing".
    expect(screen.getByText(/needs re-indexing/i)).toBeInTheDocument();
    expect(screen.getByTestId('embedding-coverage-notice')).toHaveAttribute(
      'data-coverage-status',
      'needs_reindex'
    );
  });
});
