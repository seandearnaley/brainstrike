import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileCollectionStatus } from '../use-file-collection-status';

interface MockRow {
  file_id: string;
  file_name: string;
  file_path: string;
  last_indexed: string | null;
  other_collections: string;
  searchable_chunks: string;
  total_chunks: string;
}

const mockLiveQueryState = {
  rows: [] as MockRow[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
};

const useBrainstrikeLiveQueryMock = vi.fn<(options: unknown) => typeof mockLiveQueryState>(
  () => mockLiveQueryState
);
const useFileRecordRepositoryMock = vi.fn();
const useBrainstrikeLiveQueryCapabilityMock = vi.fn(() => true);

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeLiveQuery: (options: unknown) => useBrainstrikeLiveQueryMock(options),
  useBrainstrikeLiveQueryCapability: () => useBrainstrikeLiveQueryCapabilityMock(),
  useFileRecordRepository: () => useFileRecordRepositoryMock(),
}));

describe('useFileCollectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveQueryState.rows = [];
    mockLiveQueryState.error = null;
    mockLiveQueryState.refresh = vi.fn();
    useBrainstrikeLiveQueryMock.mockReturnValue(mockLiveQueryState);
    useFileRecordRepositoryMock.mockReturnValue(null);
    useBrainstrikeLiveQueryCapabilityMock.mockReturnValue(true);
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
          file_id: 'file-1',
          file_name: 'test.ts',
          file_path: '/test/test.ts',
          searchable_chunks: '5',
          total_chunks: '5',
          other_collections: '2',
          last_indexed: '2025-11-02T10:00:00Z',
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
          file_id: 'file-1',
          file_name: 'test1.ts',
          file_path: '/test/test1.ts',
          searchable_chunks: '3',
          total_chunks: '3',
          other_collections: '0',
          last_indexed: '2025-11-02T10:00:00Z',
        },
        {
          file_id: 'file-2',
          file_name: 'test2.ts',
          file_path: '/test/test2.ts',
          searchable_chunks: '0',
          total_chunks: '5',
          other_collections: '1',
          last_indexed: null,
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
          file_id: 'file-searchable',
          file_name: 'searchable.ts',
          file_path: '/test/searchable.ts',
          searchable_chunks: '5',
          total_chunks: '5',
          other_collections: '0',
          last_indexed: '2025-11-02T10:00:00Z',
        },
        {
          file_id: 'file-not-searchable',
          file_name: 'not-searchable.ts',
          file_path: '/test/not-searchable.ts',
          searchable_chunks: '0',
          total_chunks: '5',
          other_collections: '0',
          last_indexed: null,
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

    it('handles null last_indexed gracefully', async () => {
      mockLiveQueryState.rows = [
        {
          file_id: 'file-1',
          file_name: 'test.ts',
          file_path: '/test/test.ts',
          searchable_chunks: '0',
          total_chunks: '5',
          other_collections: '0',
          last_indexed: null,
        },
      ];

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses[0]?.lastIndexedAt).toBeUndefined();
    });

    it('returns empty array when ids are not in the live map', async () => {
      mockLiveQueryState.rows = [
        {
          file_id: 'file-known',
          file_name: 'known.ts',
          file_path: '/test/known.ts',
          searchable_chunks: '1',
          total_chunks: '1',
          other_collections: '0',
          last_indexed: null,
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

      expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          params: ['collection-1'],
          query: expect.stringContaining('SELECT'),
        })
      );
    });

    it('loads requested file statuses from repository snapshots when live queries are unavailable', async () => {
      const getFileCollectionStatuses = vi.fn().mockResolvedValue([
        {
          fileId: 'file-2',
          fileName: 'repo.ts',
          filePath: '/repo.ts',
          lastIndexedAt: '2026-06-23T10:00:00.000Z',
          otherCollectionsCount: 1,
          searchableChunksCount: 2,
          searchableInActive: true,
          totalChunksCount: 3,
        },
      ]);
      useBrainstrikeLiveQueryCapabilityMock.mockReturnValue(false);
      useFileRecordRepositoryMock.mockReturnValue({ getFileCollectionStatuses });

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-2', 'missing']);

      expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
      expect(getFileCollectionStatuses).toHaveBeenCalledWith('collection-1', ['file-2', 'missing']);
      expect(statuses).toEqual([
        {
          fileId: 'file-2',
          fileName: 'repo.ts',
          filePath: '/repo.ts',
          lastIndexedAt: '2026-06-23T10:00:00.000Z',
          otherCollectionsCount: 1,
          searchableChunksCount: 2,
          searchableInActive: true,
          totalChunksCount: 3,
        },
      ]);
    });

    it('uses storage-neutral error copy when no file status backend is available', async () => {
      useBrainstrikeLiveQueryCapabilityMock.mockReturnValue(false);
      useFileRecordRepositoryMock.mockReturnValue({});

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      await expect(result.current.getFileStatus(['file-1'])).rejects.toThrow(
        'File collection status requires live query support or repository status snapshots.'
      );
      await expect(result.current.getFileStatus(['file-1'])).rejects.not.toThrow(
        'PGlite live query support'
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
