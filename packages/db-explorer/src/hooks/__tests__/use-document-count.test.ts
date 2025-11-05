import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentCount } from '../use-document-count';

// Mock the database hook
const mockQuery = vi.fn();
const mockDb = { query: mockQuery };

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => mockDb,
}));

describe('useDocumentCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when no database', async () => {
    vi.mocked(mockDb.query).mockResolvedValue({ rows: [] });

    const { result } = renderHook(() => useDocumentCount('collection-1'));

    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
  });

  it('returns undefined when no active collection', async () => {
    const { result } = renderHook(() => useDocumentCount(null));

    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('queries database with correct SQL for active collection', async () => {
    const activeCollectionId = 'collection-1';

    mockQuery.mockResolvedValue({
      rows: [{ count: '42' }],
    });

    renderHook(() => useDocumentCount(activeCollectionId));

    await waitFor(() => {
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT COUNT(*) as count'), [
        activeCollectionId,
      ]);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE embedding_set_id = $1'),
        [activeCollectionId]
      );

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('AND embedding IS NOT NULL'), [
        activeCollectionId,
      ]);
    });
  });

  it('returns correct document count', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ count: '123' }],
    });

    const { result } = renderHook(() => useDocumentCount('collection-1'));

    await waitFor(() => {
      expect(result.current).toBe(123);
    });
  });

  it('handles zero count', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ count: '0' }],
    });

    const { result } = renderHook(() => useDocumentCount('collection-1'));

    await waitFor(() => {
      expect(result.current).toBe(0);
    });
  });

  it('handles empty result rows', async () => {
    mockQuery.mockResolvedValue({
      rows: [],
    });

    const { result } = renderHook(() => useDocumentCount('collection-1'));

    await waitFor(() => {
      expect(result.current).toBe(0);
    });
  });

  it('returns undefined on database error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockRejectedValue(new Error('Database error'));

    const { result } = renderHook(() => useDocumentCount('collection-1'));

    await waitFor(() => {
      expect(result.current).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch document count'),
        expect.any(Error)
      );
    });

    consoleSpy.mockRestore();
  });

  it('refetches when collection changes', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '10' }] });

    const { result, rerender } = renderHook(({ collectionId }) => useDocumentCount(collectionId), {
      initialProps: { collectionId: 'collection-1' },
    });

    await waitFor(() => {
      expect(result.current).toBe(10);
    });

    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [{ count: '20' }] });

    rerender({ collectionId: 'collection-2' });

    await waitFor(() => {
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['collection-2']);
      expect(result.current).toBe(20);
    });
  });

  it('clears count when collection becomes null', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '10' }] });

    const { result, rerender } = renderHook(({ collectionId }) => useDocumentCount(collectionId), {
      initialProps: { collectionId: 'collection-1' as string | null },
    });

    await waitFor(() => {
      expect(result.current).toBe(10);
    });

    mockQuery.mockClear();

    rerender({ collectionId: null });

    await waitFor(() => {
      expect(result.current).toBeUndefined();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
