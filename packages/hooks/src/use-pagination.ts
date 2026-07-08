import { useCallback, useEffect, useRef, useState } from 'react';

interface UsePaginationOptions {
  initialPage?: number;
  pageSize?: number;
  totalItems: number;
}

interface UsePaginationReturn {
  currentPage: number;
  endIndex: number;
  goToNextPage: () => void;
  goToPage: (page: number) => void;
  goToPreviousPage: () => void;
  isFirstPage: boolean;
  isLastPage: boolean;
  resetToFirstPage: () => void;
  startIndex: number;
  totalPages: number;
}

export function usePagination({
  totalItems,
  pageSize = 50,
  initialPage = 0,
}: UsePaginationOptions): UsePaginationReturn {
  const [currentPage, setCurrentPage] = useState(initialPage);

  const safePageSize = Math.max(pageSize, 1);
  const totalPages = Math.ceil(totalItems / safePageSize);
  const startIndex = currentPage * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);

  const isFirstPage = currentPage === 0;
  const isLastPage = currentPage === totalPages - 1 || totalPages === 0;

  const goToPage = useCallback(
    (page: number) => {
      const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
      setCurrentPage(clampedPage);
    },
    [totalPages]
  );

  const goToNextPage = useCallback(() => {
    if (!isLastPage) {
      setCurrentPage((prev) => prev + 1);
    }
  }, [isLastPage]);

  const goToPreviousPage = useCallback(() => {
    if (!isFirstPage) {
      setCurrentPage((prev) => prev - 1);
    }
  }, [isFirstPage]);

  const resetToFirstPage = useCallback(() => {
    setCurrentPage(0);
  }, []);

  // Reset to first page when total pages changes and current page is out of bounds
  // This is intentionally a state mutation (not derivation) because:
  // 1. When data shrinks significantly, UX is better starting from page 0
  // 2. When totalPages becomes 0, we preserve currentPage for when data returns
  const prevTotalPagesRef = useRef(totalPages);
  // biome-ignore lint/plugin: Intentional state reset on bounds change - UX decision to reset to start, not just clamp
  useEffect(() => {
    if (prevTotalPagesRef.current !== totalPages) {
      prevTotalPagesRef.current = totalPages;
      if (currentPage >= totalPages && totalPages > 0) {
        setCurrentPage(0);
      }
    }
  }, [currentPage, totalPages]);

  return {
    currentPage,
    endIndex,
    goToNextPage,
    goToPage,
    goToPreviousPage,
    isFirstPage,
    isLastPage,
    resetToFirstPage,
    startIndex,
    totalPages,
  };
}
