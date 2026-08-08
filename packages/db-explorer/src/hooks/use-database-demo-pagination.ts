import { useEffect, useRef } from 'react';

interface UseDatabaseDemoPaginationOptions {
  readonly activeCollectionId: string | null;
  readonly recordPage: number;
  readonly resetRecordPagination: () => void;
  readonly setRecordPage: (page: number) => void;
  readonly totalPages: number;
}

export function useDatabaseDemoPagination({
  activeCollectionId,
  recordPage,
  resetRecordPagination,
  setRecordPage,
  totalPages,
}: UseDatabaseDemoPaginationOptions): void {
  const previousCollectionIdRef = useRef<string | null>(activeCollectionId);

  useEffect(() => {
    if (previousCollectionIdRef.current === activeCollectionId) {
      return;
    }
    previousCollectionIdRef.current = activeCollectionId;
    resetRecordPagination();
  }, [activeCollectionId, resetRecordPagination]);

  useEffect(() => {
    const maxPage = Math.max(0, totalPages - 1);
    if (recordPage <= maxPage) {
      return;
    }
    setRecordPage(maxPage);
  }, [recordPage, setRecordPage, totalPages]);
}
