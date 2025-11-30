import { useCallback, useEffect, useRef, useState } from 'react';

type UsePaginationOptions = {
  totalItems: number;
  pageSize?: number;
  initialPage?: number;
};

type UsePaginationReturn = {
  currentPage: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  goToPage: (page: number) => void;
  goToNextPage: () => void;
  goToPreviousPage: () => void;
  resetToFirstPage: () => void;
  isFirstPage: boolean;
  isLastPage: boolean;
};

export function usePagination({
  totalItems,
  pageSize = 50,
  initialPage = 0,
}: UsePaginationOptions): UsePaginationReturn {
  const [currentPage, setCurrentPage] = useState(initialPage);

  const totalPages = Math.ceil(totalItems / pageSize);
  const startIndex = currentPage * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);

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
    totalPages,
    startIndex,
    endIndex,
    goToPage,
    goToNextPage,
    goToPreviousPage,
    resetToFirstPage,
    isFirstPage,
    isLastPage,
  };
}
