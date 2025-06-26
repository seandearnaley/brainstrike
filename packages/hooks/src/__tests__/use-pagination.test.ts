import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePagination } from '../use-pagination';

describe('usePagination', () => {
  it('navigates between pages correctly', () => {
    const { result } = renderHook(() => usePagination({ totalItems: 200, pageSize: 50 }));

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
    const { result } = renderHook(() => usePagination({ totalItems: 35, pageSize: 10 }));

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
      ({ totalItems }) => usePagination({ totalItems, pageSize: 10, initialPage: 5 }),
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
});
