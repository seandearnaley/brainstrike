import { useEffect, useRef } from 'react';
import { useDatabaseDemoStore } from '../stores/database-demo-store';

interface UseDatabaseDemoPaginationOptions {
  readonly activeCollectionId: string | null;
  readonly totalPages: number;
}

export function useDatabaseDemoPagination({
  activeCollectionId,
  totalPages,
}: UseDatabaseDemoPaginationOptions): void {
  const recordPage = useDatabaseDemoStore((state) => state.recordPage);
  const resetRecordPagination = useDatabaseDemoStore((state) => state.resetRecordPagination);
  const setRecordPage = useDatabaseDemoStore((state) => state.setRecordPage);
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
