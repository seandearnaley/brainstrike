import { usePGliteLiveQuery } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { useMemo } from 'react';

const logger = createLogger('useDocumentCount');

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
const DOCUMENT_COUNT_QUERY = `
  SELECT COUNT(*)::int AS count
    FROM file_chunks
   WHERE embedding_set_id = $1
     AND embedding IS NOT NULL
`.trim();

export function useDocumentCount(activeCollectionId: string | null): number | undefined {
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error } = usePGliteLiveQuery<{ count: number }>({
    query: DOCUMENT_COUNT_QUERY,
    ...(params ? { params } : {}),
    enabled: Boolean(activeCollectionId),
  });

  return useMemo(() => {
    if (!activeCollectionId) {
      return undefined;
    }
    if (error) {
      logger.error('Failed to fetch document count', { error });
      return undefined;
    }
    const row = rows[0];
    if (!row) {
      return 0;
    }
    return Number.isFinite(row.count) ? row.count : 0;
  }, [activeCollectionId, rows, error]);
}
