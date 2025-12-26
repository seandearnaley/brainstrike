import { usePGliteLiveQuery } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { useMemo, useRef } from 'react';

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
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);
  const liveQueryEnabled = Boolean(activeCollectionId) && !isImporting && !isEmbeddingActive;
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error } = usePGliteLiveQuery<{ count: number }>({
    query: INDEXED_CHUNK_COUNT_QUERY,
    ...(params ? { params } : {}),
    enabled: liveQueryEnabled,
  });

  const computed = useMemo(() => {
    if (!(liveQueryEnabled && activeCollectionId)) {
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
  }, [activeCollectionId, error, liveQueryEnabled, rows]);

  const snapshotRef = useRef<number | undefined>(undefined);
  if (liveQueryEnabled) {
    snapshotRef.current = computed;
  }

  return liveQueryEnabled ? computed : snapshotRef.current;
}

/**
 * @deprecated Use useIndexedChunkCount instead for clearer terminology
 */
export const useDocumentCount = useIndexedChunkCount;
