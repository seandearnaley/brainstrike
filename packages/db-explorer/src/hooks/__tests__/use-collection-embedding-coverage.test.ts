import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCoverageStatus,
  useCollectionEmbeddingCoverage,
} from '../use-collection-embedding-coverage';

interface MockCoverageRow {
  chunksmissing: number;
  embeddingsetid: string;
  pendingreindexfiles: number;
  totalchunks: number;
  totalfiles: number;
}

const mockLiveQueryState = {
  rows: [] as MockCoverageRow[],
  loading: false,
  error: null as Error | null,
};

const useBrainstrikeLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
  useOptionalPGliteDatabase: vi.fn(() => ({})),
}));

import { useOptionalPGliteDatabase } from '@brainstrike/db';

describe('collection embedding coverage status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveQueryState.rows = [];
    mockLiveQueryState.loading = false;
    mockLiveQueryState.error = null;
    useBrainstrikeLiveQueryMock.mockReturnValue(mockLiveQueryState);
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue({} as never);
  });

  it('reports idle when the collection has no files', () => {
    expect(resolveCoverageStatus(0, 0, 0)).toBe('idle');
  });

  it('reports needs_reindex when files lack processed chunks', () => {
    expect(resolveCoverageStatus(12, 4, 0)).toBe('needs_reindex');
  });

  it('reports partial_source_ranges when chunks lack line metadata', () => {
    expect(resolveCoverageStatus(8, 0, 3)).toBe('partial_source_ranges');
  });

  it('reports fully_indexed when files and chunks are line-aware', () => {
    expect(resolveCoverageStatus(5, 0, 0)).toBe('fully_indexed');
  });

  it('ignores a stale live-query row for a previous active collection', () => {
    mockLiveQueryState.rows = [
      {
        embeddingsetid: 'previous-collection',
        totalfiles: 3,
        totalchunks: 9,
        pendingreindexfiles: 3,
        chunksmissing: 0,
      },
    ];

    const { result } = renderHook(() => useCollectionEmbeddingCoverage('active-collection'));

    expect(result.current.snapshot.status).toBe('idle');
  });

  it('disables the live coverage query when no PGlite live source is available', () => {
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);

    renderHook(() => useCollectionEmbeddingCoverage('active-collection'));

    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      })
    );
  });
});
