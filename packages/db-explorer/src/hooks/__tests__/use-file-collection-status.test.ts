import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileCollectionStatus } from '../use-file-collection-status';

type MockRow = {
  fileId: string;
  fileName: string;
  filePath: string;
  searchableChunks: string;
  totalChunks: string;
  otherCollections: string;
  lastIndexed: string | null;
};

const mockLiveQueryState = {
  rows: [] as MockRow[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
};

const usePGliteLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: (options: unknown) => usePGliteLiveQueryMock(options),
}));

describe('useFileCollectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveQueryState.rows = [];
    mockLiveQueryState.error = null;
    mockLiveQueryState.refresh = vi.fn();
    usePGliteLiveQueryMock.mockReturnValue(mockLiveQueryState);
  });

  describe('getFileStatus', () => {
    it('returns empty array when no active collection', async () => {
      const { result } = renderHook(() => useFileCollectionStatus(null));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses).toEqual([]);
    });

    it('returns empty array when no file IDs provided', async () => {
      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus([]);

      expect(statuses).toEqual([]);
    });

    it('maps live query rows for a single file', async () => {
      mockLiveQueryState.rows = [
        {
          fileId: 'file-1',
          fileName: 'test.ts',
          filePath: '/test/test.ts',
          searchableChunks: '5',
          totalChunks: '5',
          otherCollections: '2',
          lastIndexed: '2025-11-02T10:00:00Z',
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        fileId: 'file-1',
        fileName: 'test.ts',
        filePath: '/test/test.ts',
        searchableInActive: true,
        searchableChunksCount: 5,
        totalChunksCount: 5,
        otherCollectionsCount: 2,
        lastIndexedAt: '2025-11-02T10:00:00Z',
      });
    });

    it('returns statuses only for requested ids', async () => {
      mockLiveQueryState.rows = [
        {
          fileId: 'file-1',
          fileName: 'test1.ts',
          filePath: '/test/test1.ts',
          searchableChunks: '3',
          totalChunks: '3',
          otherCollections: '0',
          lastIndexed: '2025-11-02T10:00:00Z',
        },
        {
          fileId: 'file-2',
          fileName: 'test2.ts',
          filePath: '/test/test2.ts',
          searchableChunks: '0',
          totalChunks: '5',
          otherCollections: '1',
          lastIndexed: null,
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-2']);

      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.fileId).toBe('file-2');
    });

    it('maps searchableInActive flag based on chunk count', async () => {
      mockLiveQueryState.rows = [
        {
          fileId: 'file-searchable',
          fileName: 'searchable.ts',
          filePath: '/test/searchable.ts',
          searchableChunks: '5',
          totalChunks: '5',
          otherCollections: '0',
          lastIndexed: '2025-11-02T10:00:00Z',
        },
        {
          fileId: 'file-not-searchable',
          fileName: 'not-searchable.ts',
          filePath: '/test/not-searchable.ts',
          searchableChunks: '0',
          totalChunks: '5',
          otherCollections: '0',
          lastIndexed: null,
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus([
        'file-searchable',
        'file-not-searchable',
      ]);

      expect(statuses[0]?.searchableInActive).toBe(true);
      expect(statuses[1]?.searchableInActive).toBe(false);
    });

    it('handles null lastIndexed gracefully', async () => {
      mockLiveQueryState.rows = [
        {
          fileId: 'file-1',
          fileName: 'test.ts',
          filePath: '/test/test.ts',
          searchableChunks: '0',
          totalChunks: '5',
          otherCollections: '0',
          lastIndexed: null,
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses[0]?.lastIndexedAt).toBeUndefined();
    });

    it('returns empty array when ids are not in the live map', async () => {
      mockLiveQueryState.rows = [
        {
          fileId: 'file-known',
          fileName: 'known.ts',
          filePath: '/test/known.ts',
          searchableChunks: '1',
          totalChunks: '1',
          otherCollections: '0',
          lastIndexed: null,
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['missing']);

      expect(statuses).toEqual([]);
    });

    it('exposes live query errors', () => {
      const testError = new Error('live query failed');
      mockLiveQueryState.error = testError;

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      expect(result.current.error).toBe(testError);
    });

    it('configures live query for the active collection id', () => {
      renderHook(() => useFileCollectionStatus('collection-1'));

      expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          params: ['collection-1'],
          query: expect.stringContaining('SELECT'),
        })
      );
    });
  });

  describe('Hook re-renders', () => {
    it('returns stable getFileStatus reference when activeCollectionId unchanged', () => {
      const { result, rerender } = renderHook(() => useFileCollectionStatus('collection-1'));

      const firstGetFileStatus = result.current.getFileStatus;

      rerender();

      expect(result.current.getFileStatus).toBe(firstGetFileStatus);
    });

    it('returns new getFileStatus reference when activeCollectionId changes', () => {
      const { result, rerender } = renderHook(
        ({ collectionId }) => useFileCollectionStatus(collectionId),
        { initialProps: { collectionId: 'collection-1' } }
      );

      const firstGetFileStatus = result.current.getFileStatus;

      rerender({ collectionId: 'collection-2' });

      expect(result.current.getFileStatus).not.toBe(firstGetFileStatus);
    });
  });
});
