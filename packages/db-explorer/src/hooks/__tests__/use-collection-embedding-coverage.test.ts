import { act, renderHook } from '@testing-library/react';
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
const useFileChunkRepositoryMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
  useFileChunkRepository: () => useFileChunkRepositoryMock(),
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
    useFileChunkRepositoryMock.mockReturnValue(null);
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

  it('loads collection coverage from repository snapshots when PGlite live queries are unavailable', async () => {
    const getCollectionEmbeddingCoverage = vi.fn().mockResolvedValue({
      chunksMissingSourceRange: 2,
      pendingReindexFileCount: 0,
      totalChunks: 9,
      totalFiles: 3,
    });
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileChunkRepositoryMock.mockReturnValue({ getCollectionEmbeddingCoverage });

    const { result } = renderHook(() => useCollectionEmbeddingCoverage('collection-turso'));

    expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(getCollectionEmbeddingCoverage).toHaveBeenCalledWith('collection-turso');
    await expect
      .poll(() => result.current.snapshot)
      .toEqual({
        chunksMissingSourceRange: 2,
        pendingReindexFileCount: 0,
        status: 'partial_source_ranges',
        totalChunks: 9,
        totalFiles: 3,
      });
  });

  it('refreshes repository coverage when the active collection queue drains', async () => {
    const getCollectionEmbeddingCoverage = vi
      .fn()
      .mockResolvedValueOnce({
        chunksMissingSourceRange: 0,
        pendingReindexFileCount: 1,
        totalChunks: 1,
        totalFiles: 1,
      })
      .mockResolvedValueOnce({
        chunksMissingSourceRange: 0,
        pendingReindexFileCount: 0,
        totalChunks: 2,
        totalFiles: 1,
      });
    vi.mocked(useOptionalPGliteDatabase).mockReturnValue(null as never);
    useFileChunkRepositoryMock.mockReturnValue({ getCollectionEmbeddingCoverage });

    const { result } = renderHook(() => useCollectionEmbeddingCoverage('collection-turso'));

    await expect.poll(() => result.current.snapshot.status).toBe('needs_reindex');
    expect(getCollectionEmbeddingCoverage).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'other-collection' },
        })
      );
    });
    expect(getCollectionEmbeddingCoverage).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('brainstrike:queue-drained', {
          detail: { embeddingSetId: 'collection-turso' },
        })
      );
    });

    await expect.poll(() => getCollectionEmbeddingCoverage).toHaveBeenCalledTimes(2);
    await expect
      .poll(() => result.current.snapshot)
      .toEqual({
        chunksMissingSourceRange: 0,
        pendingReindexFileCount: 0,
        status: 'fully_indexed',
        totalChunks: 2,
        totalFiles: 1,
      });
  });
});
