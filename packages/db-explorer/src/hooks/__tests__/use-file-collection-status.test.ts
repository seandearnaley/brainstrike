import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileCollectionStatus } from '../use-file-collection-status';

// Mock the database hook
const mockQuery = vi.fn();
const mockDb = { query: mockQuery };

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => mockDb,
}));

describe('useFileCollectionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getFileStatus', () => {
    it('returns empty array when no database', async () => {
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [] });

      const { result } = renderHook(() => useFileCollectionStatus(null));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns empty array when no active collection', async () => {
      const { result } = renderHook(() => useFileCollectionStatus(null));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns empty array when no file IDs provided', async () => {
      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus([]);

      expect(statuses).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('queries database with correct SQL for single file', async () => {
      const activeCollectionId = 'collection-1';
      const fileIds = ['file-1'];

      mockQuery.mockResolvedValue({
        rows: [
          {
            file_id: 'file-1',
            file_name: 'test.ts',
            file_path: '/test/test.ts',
            searchable_chunks: '5',
            total_chunks: '5',
            other_collections: '2',
            last_indexed: '2025-11-02T10:00:00Z',
          },
        ],
      });

      const { result } = renderHook(() => useFileCollectionStatus(activeCollectionId));

      await waitFor(async () => {
        const statuses = await result.current.getFileStatus(fileIds);

        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT'), [
          activeCollectionId,
          ...fileIds,
        ]);

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
    });

    it('queries database with correct SQL for multiple files', async () => {
      const activeCollectionId = 'collection-1';
      const fileIds = ['file-1', 'file-2', 'file-3'];

      mockQuery.mockResolvedValue({
        rows: [
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
          {
            file_id: 'file-3',
            file_name: 'test3.ts',
            file_path: '/test/test3.ts',
            searchable_chunks: '10',
            total_chunks: '10',
            other_collections: '3',
            last_indexed: '2025-11-01T15:30:00Z',
          },
        ],
      });

      const { result } = renderHook(() => useFileCollectionStatus(activeCollectionId));

      await waitFor(async () => {
        const statuses = await result.current.getFileStatus(fileIds);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('WHERE fr.id IN ($2, $3, $4)'),
          [activeCollectionId, ...fileIds]
        );

        expect(statuses).toHaveLength(3);
      });
    });

    it('correctly maps searchableInActive based on searchable_chunks', async () => {
      mockQuery.mockResolvedValue({
        rows: [
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
        ],
      });

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      await waitFor(async () => {
        const statuses = await result.current.getFileStatus([
          'file-searchable',
          'file-not-searchable',
        ]);

        expect(statuses[0]?.searchableInActive).toBe(true);
        expect(statuses[1]?.searchableInActive).toBe(false);
      });
    });

    it('handles null last_indexed gracefully', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            file_id: 'file-1',
            file_name: 'test.ts',
            file_path: '/test/test.ts',
            searchable_chunks: '0',
            total_chunks: '5',
            other_collections: '0',
            last_indexed: null,
          },
        ],
      });

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      await waitFor(async () => {
        const statuses = await result.current.getFileStatus(['file-1']);

        expect(statuses[0]?.lastIndexedAt).toBeUndefined();
      });
    });

    it('returns empty array on database error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockQuery.mockRejectedValue(new Error('Database error'));

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      const statuses = await result.current.getFileStatus(['file-1']);

      expect(statuses).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get file status'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('uses correct SQL query structure', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const { result } = renderHook(() => useFileCollectionStatus('collection-1'));

      await result.current.getFileStatus(['file-1']);

      const sql = mockQuery.mock.calls[0]?.[0] as string;

      // Verify SQL structure
      expect(sql).toContain('SELECT');
      expect(sql).toContain('fr.id AS file_id');
      expect(sql).toContain('COUNT(fc.id) FILTER');
      expect(sql).toContain('WHERE fc.embedding_set_id = $1');
      expect(sql).toContain('LEFT JOIN file_chunks fc');
      expect(sql).toContain('GROUP BY fr.id');
      expect(sql).toContain('ORDER BY fr.created_at DESC');
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
