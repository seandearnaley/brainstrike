import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useMemo, useRef } from 'react';

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
  SELECT embedded_chunk_count::int AS count
    FROM collection_indexing_stats
   WHERE embedding_set_id = $1
     AND dirty = FALSE
`.trim();

export function useIndexedChunkCount(activeCollectionId: string | null): number | undefined {
  const liveQueryEnabled = Boolean(activeCollectionId);
  const params = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? ([activeCollectionId] as const) : undefined),
    [activeCollectionId]
  );

  const { rows, error, refresh } = usePGliteLiveQuery<{ count: number }>({
    cacheKey: makeLiveQueryKey('indexed-chunk-count', activeCollectionId),
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
      return;
    }
    return Number.isFinite(row.count) ? row.count : 0;
  }, [activeCollectionId, error, liveQueryEnabled, rows]);

  const snapshotRef = useRef<number | undefined>(undefined);
  if (liveQueryEnabled) {
    snapshotRef.current = computed;
  }

  const previousLiveQueryEnabledRef = useRef(liveQueryEnabled);

  useEffect(() => {
    const wasEnabled = previousLiveQueryEnabledRef.current;
    previousLiveQueryEnabledRef.current = liveQueryEnabled;
    if (!(liveQueryEnabled && !wasEnabled)) {
      return;
    }
    void refresh();
  }, [liveQueryEnabled, refresh]);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeCollectionId) {
      return;
    }

    const handleQueueDrained = (event: Event) => {
      const detail = (event as CustomEvent<{ embeddingSetId?: string | null } | undefined>).detail;
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeCollectionId) {
        return;
      }
      void refresh();
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [activeCollectionId, refresh]);

  return liveQueryEnabled ? computed : snapshotRef.current;
}

/**
 * @deprecated Use useIndexedChunkCount instead for clearer terminology
 */
export const useDocumentCount = useIndexedChunkCount;
