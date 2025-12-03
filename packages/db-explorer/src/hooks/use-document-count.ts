import { usePGliteLiveQuery } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils';
import { useMemo } from 'react';

const logger = createLogger('useIndexedChunkCount');
export const indexedChunkCountLogger = logger;

/**
 * @deprecated Use useIndexedChunkCount instead for clearer terminology
 */
export const documentCountLogger = logger;

/**
 * Hook to get the count of indexed chunks (chunks with embeddings) in a collection.
 *
 * Terminology:
 * - Files: Imported file_records
 * - Chunks: Pieces of files split for embedding (file_chunks)
 * - Indexed chunks: Chunks with embeddings (searchable)
 *
 * @param activeCollectionId - The embedding set ID to count chunks for
 * @returns Number of chunks with embeddings, or undefined if loading/no collection
 *
 * @example
 * ```tsx
 * const indexedChunks = useIndexedChunkCount(activeCollectionId);
 * // indexedChunks = count of file_chunks with non-null embedding for the set
 * ```
 */
const INDEXED_CHUNK_COUNT_QUERY = `
  SELECT COUNT(*)::int AS count
    FROM file_chunks
   WHERE embedding_set_id = $1
     AND embedding IS NOT NULL
`.trim();

export function useIndexedChunkCount(activeCollectionId: string | null): number | undefined {
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error } = usePGliteLiveQuery<{ count: number }>({
    query: INDEXED_CHUNK_COUNT_QUERY,
    ...(params ? { params } : {}),
    enabled: Boolean(activeCollectionId),
  });

  return useMemo(() => {
    if (!activeCollectionId) {
      return;
    }
    if (error) {
      logger.error('Failed to fetch indexed chunk count', { error });
      return;
    }
    const row = rows[0];
    if (!row) {
      return 0;
    }
    return Number.isFinite(row.count) ? row.count : 0;
  }, [activeCollectionId, rows, error]);
}

/**
 * @deprecated Use useIndexedChunkCount instead for clearer terminology
 */
export const useDocumentCount = useIndexedChunkCount;
