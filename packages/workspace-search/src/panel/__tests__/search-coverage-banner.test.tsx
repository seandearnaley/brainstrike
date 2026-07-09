import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectionStatsRow } from '../collection-stats-query';

// The banner runs two live queries (collection stats + total files). Route the
// mock by the query text so each returns its own rows/loading flag.
interface MockLiveResult {
  loading: boolean;
  rows: unknown[];
}
const liveResults: { stats: MockLiveResult; totals: MockLiveResult } = {
  stats: { loading: false, rows: [] },
  totals: { loading: false, rows: [] },
};

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: (...parts: unknown[]) => parts.join(':'),
  usePGliteLiveQuery: ({ query }: { query: string }) =>
    query.includes('collection_indexing_stats') ? liveResults.stats : liveResults.totals,
}));

const syncStore = { managedCollectionId: null as string | null, state: 'idle' as string };
vi.mock('@brainstrike/preferences/stores/workspace-collection-sync-status-store', () => ({
  useWorkspaceCollectionSyncStatusStore: (selector: (s: typeof syncStore) => unknown) =>
    selector(syncStore),
}));

import { SearchCoverageBanner } from '../search-coverage-banner';

function statsRow(overrides: Partial<CollectionStatsRow> = {}): CollectionStatsRow {
  return {
    chunkCount: 10,
    embeddedChunkCount: 10,
    fileCount: 10,
    id: 'ws-index',
    name: 'Workspace Index',
    pendingChunkCount: 0,
    systemRole: 'workspace-index',
    ...overrides,
  };
}

beforeEach(() => {
  liveResults.stats = { loading: false, rows: [statsRow()] };
  liveResults.totals = { loading: false, rows: [{ total: 10 }] };
  syncStore.managedCollectionId = null;
  syncStore.state = 'idle';
});

describe('SearchCoverageBanner', () => {
  it('the LIVE indexing signal overrides stale "fully-indexed" stats', () => {
    // Stats read as complete (fileCount === totalFiles, pending 0) but the
    // background indexer is actively embedding the managed (workspace-index) set.
    syncStore.managedCollectionId = 'ws-index';
    syncStore.state = 'embedding';

    render(<SearchCoverageBanner collectionId={null} rootIds={['r1']} />);

    expect(screen.getByRole('status')).toHaveTextContent('Indexing…');
  });

  it('does not treat a different managed collection as indexing the displayed set', () => {
    syncStore.managedCollectionId = 'some-other-set';
    syncStore.state = 'embedding';

    const { container } = render(<SearchCoverageBanner collectionId={null} rootIds={['r1']} />);
    // Stats say complete, indexer is on a different set -> nothing rendered.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the totals count query is loading (not via the complete path)', () => {
    // Partially-indexed stats that WOULD render "5 of 10" once totals load.
    liveResults.stats = { loading: false, rows: [statsRow({ fileCount: 5 })] };
    liveResults.totals = { loading: true, rows: [] };

    const { container } = render(<SearchCoverageBanner collectionId={null} rootIds={['r1']} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the partial-coverage banner once totals have loaded', () => {
    liveResults.stats = { loading: false, rows: [statsRow({ fileCount: 5 })] };
    liveResults.totals = { loading: false, rows: [{ total: 10 }] };

    render(<SearchCoverageBanner collectionId={null} rootIds={['r1']} />);
    expect(screen.getByRole('status')).toHaveTextContent('5 of 10 files indexed');
  });
});
