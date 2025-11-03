import { usePGliteDatabase } from '@brainstrike/db';
import { useCallback, useEffect, useState } from 'react';

/**
 * Hook to get the count of indexed documents (chunks with embeddings) in the active collection
 *
 * @param activeCollectionId - The active embedding set ID
 * @returns Number of indexed documents, or undefined if loading/no collection
 *
 * @example
 * ```tsx
 * const documentCount = useDocumentCount(activeCollectionId);
 * // documentCount will be the count of chunks with embeddings in the active collection
 * ```
 */
export function useDocumentCount(activeCollectionId: string | null): number | undefined {
  const db = usePGliteDatabase();
  const [count, setCount] = useState<number | undefined>(undefined);

  const fetchCount = useCallback(async () => {
    if (!db || !activeCollectionId) {
      setCount(undefined);
      return;
    }

    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM file_chunks
         WHERE embedding_set_id = $1
         AND embedding IS NOT NULL`,
        [activeCollectionId]
      );

      const countValue = result.rows[0]?.count;
      setCount(countValue ? Number.parseInt(countValue, 10) : 0);
    } catch (error) {
      console.error('[useDocumentCount] Failed to fetch document count:', error);
      setCount(undefined);
    }
  }, [db, activeCollectionId]);

  useEffect(() => {
    void fetchCount();
  }, [fetchCount]);

  return count;
}
