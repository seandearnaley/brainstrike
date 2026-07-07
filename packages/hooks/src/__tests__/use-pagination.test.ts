import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagination } from '../use-pagination';

describe('usePagination', () => {
  it('navigates between pages correctly', () => {
    const { result } = renderHook(() => usePagination({ pageSize: 50, totalItems: 200 }));

    expect(result.current.currentPage).toBe(0);
    expect(result.current.totalPages).toBe(4);
    expect(result.current.startIndex).toBe(0);
    expect(result.current.endIndex).toBe(50);

    act(() => {
      result.current.goToNextPage();
    });
    expect(result.current.currentPage).toBe(1);
    expect(result.current.startIndex).toBe(50);
    expect(result.current.endIndex).toBe(100);

    act(() => {
      result.current.goToPreviousPage();
    });
    expect(result.current.currentPage).toBe(0);

    act(() => {
      result.current.goToPage(3);
    });
    expect(result.current.currentPage).toBe(3);
    expect(result.current.isLastPage).toBe(true);
    expect(result.current.startIndex).toBe(150);
    expect(result.current.endIndex).toBe(200);
  });

  it('handles boundary conditions', () => {
    const { result } = renderHook(() => usePagination({ pageSize: 10, totalItems: 35 }));

    expect(result.current.totalPages).toBe(4);

    act(() => {
      result.current.goToPreviousPage();
    });
    expect(result.current.currentPage).toBe(0);

    act(() => {
      result.current.goToPage(-5);
    });
    expect(result.current.currentPage).toBe(0);

    act(() => {
      result.current.goToPage(10);
    });
    expect(result.current.currentPage).toBe(3);
    expect(result.current.isLastPage).toBe(true);

    act(() => {
      result.current.goToNextPage();
    });
    expect(result.current.currentPage).toBe(3);
  });

  it('resets to first page when totalItems decreases and current page is out of bounds', () => {
    const { result, rerender } = renderHook(
      ({ totalItems }) => usePagination({ initialPage: 5, pageSize: 10, totalItems }),
      { initialProps: { totalItems: 100 } }
    );

    expect(result.current.currentPage).toBe(5);
    expect(result.current.totalPages).toBe(10);

    act(() => {
      rerender({ totalItems: 30 });
    });

    expect(result.current.totalPages).toBe(3);
    expect(result.current.currentPage).toBe(0);
  });

  it('should handle edge case when totalPages is exactly 0', () => {
    const { result } = renderHook(() => usePagination({ pageSize: 10, totalItems: 0 }));

    expect(result.current.currentPage).toBe(0);
    expect(result.current.totalPages).toBe(0);
    expect(result.current.isFirstPage).toBe(true);
    expect(result.current.isLastPage).toBe(true);
  });

  it('should handle transition from non-zero to zero pages', () => {
    const { result, rerender } = renderHook(
      ({ totalItems }) => usePagination({ pageSize: 10, totalItems }),
      { initialProps: { totalItems: 50 } }
    );

    act(() => {
      result.current.goToPage(2);
    });

    expect(result.current.currentPage).toBe(2);

    act(() => {
      rerender({ totalItems: 0 });
    });

    // When totalPages is 0, the reset condition (totalPages > 0) is false
    // so currentPage stays at 2, but isLastPage becomes true
    expect(result.current.currentPage).toBe(2);
    expect(result.current.totalPages).toBe(0);
    expect(result.current.isLastPage).toBe(true);
  });

  it('should reset to first page when current page equals totalPages', () => {
    const { result, rerender } = renderHook(
      ({ totalItems }) => usePagination({ pageSize: 10, totalItems }),
      { initialProps: { totalItems: 50 } }
    );

    act(() => {
      result.current.goToPage(4); // Last page (0-indexed)
    });

    expect(result.current.currentPage).toBe(4);

    act(() => {
      rerender({ totalItems: 30 }); // Reduces to 3 pages
    });

    expect(result.current.totalPages).toBe(3);
    expect(result.current.currentPage).toBe(0);
  });

  it('should handle page boundary when totalPages is 1', () => {
    const { result } = renderHook(() => usePagination({ pageSize: 10, totalItems: 5 }));

    expect(result.current.totalPages).toBe(1);
    expect(result.current.isFirstPage).toBe(true);
    expect(result.current.isLastPage).toBe(true);

    act(() => {
      result.current.goToNextPage();
    });
    expect(result.current.currentPage).toBe(0);

    act(() => {
      result.current.goToPreviousPage();
    });
    expect(result.current.currentPage).toBe(0);
  });

  it('should correctly calculate isLastPage for exact page boundary', () => {
    const { result } = renderHook(() => usePagination({ pageSize: 10, totalItems: 50 }));

    expect(result.current.totalPages).toBe(5);

    act(() => {
      result.current.goToPage(4);
    });

    expect(result.current.currentPage).toBe(4);
    expect(result.current.isLastPage).toBe(true);
    expect(result.current.endIndex).toBe(50);
  });
});
