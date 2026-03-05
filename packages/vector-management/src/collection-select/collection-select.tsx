import type { usePGliteDatabase } from '@brainstrike/db';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

/**
 * Row shape returned by the collections query
 */
export interface CollectionRow {
  category: string | null;
  chunkCount: string | number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: string;
  embeddingCount: string | number;
  fileCount: string | number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  tags: string | null;
}

/**
 * Normalized collection data with file count
 *
 * Terminology:
 * - fileCount: Number of imported files (file_records) in this collection
 * - chunkCount: Number of chunks (file_chunks) in this collection
 * - embeddingCount: Number of chunks with embeddings in this collection
 */
export interface CollectionWithDocCount {
  category: string | null;
  /** Number of chunks in this collection */
  chunkCount: number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  /** Number of embeddings in this collection */
  embeddingCount: number;
  /** Number of files imported into this collection */
  fileCount: number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  tags: string | null;
}

/**
 * SQL query to fetch all embedding sets with their file counts.
 * Uses LEFT JOIN to include collections with zero files.
 */
const COLLECTIONS_QUERY = `
    WITH file_counts AS (
      SELECT embedding_set_id, COUNT(*)::int AS file_count
        FROM file_records
       GROUP BY embedding_set_id
    ),
    chunk_counts AS (
      SELECT
        embedding_set_id,
        COUNT(*)::int AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedding_count
      FROM file_chunks
      GROUP BY embedding_set_id
    )
    SELECT
      s.id,
      s.model_key AS "modelKey",
      s.model_id AS "modelId",
      s.dimensions,
      s.distance,
      s.created_at AS "createdAt",
      s.name,
      s.description,
      s.tags,
      s.category,
      COALESCE(f.file_count, 0) AS "fileCount",
      COALESCE(c.chunk_count, 0) AS "chunkCount",
      COALESCE(c.embedding_count, 0) AS "embeddingCount"
    FROM embedding_sets s
    LEFT JOIN file_counts f ON f.embedding_set_id = s.id
    LEFT JOIN chunk_counts c ON c.embedding_set_id = s.id
    ORDER BY s.created_at DESC
  `.trim();

export type CollectionSelectSize = 'compact' | 'default';

/**
 * Size-based styling configuration for CollectionSelect
 */
const SIZE_STYLES = {
  compact: {
    trigger: 'h-7 text-[10px]',
    item: 'text-xs',
    content: 'max-w-[300px]',
  },
  default: {
    trigger: '',
    item: '',
    content: 'max-w-[400px]',
  },
} as const;

export interface CollectionSelectProps {
  /**
   * Pre-fetched collections data. If provided, skips internal useCollections hook.
   * Use this to avoid duplicate queries when parent already has the data.
   */
  collections?: CollectionWithDocCount[];

  /**
   * Additional className for the content dropdown
   */
  contentClassName?: string;
  /**
   * Database instance for querying collections.
   * Required if collections/loading/error are not provided (will fetch internally).
   * Ignored if collections are provided externally.
   */
  db?: ReturnType<typeof usePGliteDatabase>;

  /**
   * Custom empty state to render when no collections exist
   * If not provided, the select will be disabled with the placeholder text
   */
  emptyState?: React.ReactNode;

  /**
   * Error state (used when collections are provided externally)
   */
  error?: Error | null;

  /**
   * Loading state (used when collections are provided externally)
   */
  loading?: boolean;

  /**
   * Placeholder text when loading
   */
  loadingPlaceholder?: string;

  /**
   * Optional callback when an error occurs loading collections
   */
  onError?: (error: Error) => void;

  /**
   * Callback when selection changes
   */
  onSelectionChange: (id: string | null) => void;

  /**
   * Placeholder text when no collection is selected
   */
  placeholder?: string;

  /**
   * Currently selected collection ID
   */
  selectedId: string | null;

  /**
   * Size variant - 'compact' for tight spaces like Vector Status,
   * 'default' for full-size like Database Explorer
   */
  size?: CollectionSelectSize;

  /**
   * Additional className for the trigger
   */
  triggerClassName?: string;
}

/**
 * Hook to report errors to parent callback (only once per unique error)
 */
function useErrorReporting(error: Error | null | undefined, onError?: (error: Error) => void) {
  const lastErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (error && error instanceof Error) {
      if (lastErrorRef.current !== error.message) {
        lastErrorRef.current = error.message;
        onError?.(error);
      }
    } else if (!error) {
      lastErrorRef.current = null;
    }
  }, [error, onError]);
}

/**
 * Hook to resolve collection data from either external props or internal fetch
 */
function useResolvedCollectionData(
  db: ReturnType<typeof usePGliteDatabase> | undefined,
  externalCollections?: CollectionWithDocCount[],
  externalLoading?: boolean,
  externalError?: Error | null
) {
  const shouldFetchInternally = externalCollections === undefined;
  const internalData = useCollections(shouldFetchInternally ? db : null);

  return {
    collections: externalCollections ?? internalData.collections,
    loading: externalLoading ?? internalData.loading,
    error: externalError ?? internalData.error,
    shouldFetchInternally,
  };
}

/**
 * Hook to fetch and normalize collection data
 */
function normalizeCollectionRows(rows: CollectionRow[]): CollectionWithDocCount[] {
  return rows.map((row) => ({
    id: row.id,
    modelKey: row.modelKey,
    modelId: row.modelId,
    dimensions: row.dimensions,
    distance: row.distance as 'cosine' | 'l2' | 'ip',
    createdAt: row.createdAt,
    name: row.name,
    description: row.description,
    tags: row.tags,
    category: row.category,
    fileCount: Number(row.fileCount ?? 0),
    chunkCount: Number(row.chunkCount ?? 0),
    embeddingCount: Number(row.embeddingCount ?? 0),
  }));
}

export function useCollections(db: ReturnType<typeof usePGliteDatabase> | null | undefined) {
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const schemaVerified = useVectorStatusUIStore((s) => s.schemaVerified);
  // Use Zustand store for caching - persists across component unmounts during bulk operations
  const cachedCollections = useVectorStatusUIStore((s) => s.cachedCollections);
  const setCachedCollections = useVectorStatusUIStore((s) => s.setCachedCollections);
  // Only enable live queries when:
  // 1. Database is available
  // 2. Schema has been verified (migrations completed, tables exist)
  // 3. Not currently importing files (to avoid perf degradation during bulk inserts)
  //
  // NOTE: We do NOT disable during embedding generation (isEmbeddingActive) because:
  // - This query only fires when embedding_sets or file_records change
  // - Embedding generation updates file_chunks.embedding, not these tables
  // - Users need to see collections while searching/browsing during embedding
  // - Only the queue monitoring queries in useVectorQueueState need to be paused
  const liveQueryEnabled = Boolean(db) && schemaVerified && !isImporting;
  // Track loading/error state for initial fetch
  interface FetchState {
    error: Error | null;
    loading: boolean;
  }
  type FetchAction =
    | { type: 'start' }
    | { type: 'success' }
    | { type: 'error'; error: Error }
    | { type: 'reset' };
  const [fetchState, dispatchFetch] = useReducer(
    (_state: FetchState, action: FetchAction): FetchState => {
      switch (action.type) {
        case 'start':
          return { loading: true, error: null };
        case 'success':
          return { loading: false, error: null };
        case 'error':
          return { loading: false, error: action.error };
        case 'reset':
          return { loading: false, error: null };
      }
    },
    { loading: false, error: null }
  );
  // Track if we've done the initial fetch (separate from live query)
  const initialFetchedRef = useRef(false);

  const {
    rows: rawCollections,
    loading,
    error,
    refresh,
  } = usePGliteLiveQuery<CollectionRow>({
    cacheKey: makeLiveQueryKey('collections'),
    query: COLLECTIONS_QUERY,
    enabled: liveQueryEnabled,
  });

  // Listen for embedding set update events (create/delete/rename) and refresh live query
  // This ensures UI updates on Electron where PGlite live query may not auto-detect changes
  useEffect(() => {
    if (typeof window === 'undefined' || !liveQueryEnabled) {
      return;
    }

    const handleEmbeddingSetUpdated = () => {
      void refresh();
    };

    window.addEventListener('brainstrike:embedding-set-updated', handleEmbeddingSetUpdated);

    return () => {
      window.removeEventListener('brainstrike:embedding-set-updated', handleEmbeddingSetUpdated);
    };
  }, [liveQueryEnabled, refresh]);

  const collections = useMemo<CollectionWithDocCount[]>(
    () => normalizeCollectionRows(rawCollections),
    [rawCollections]
  );

  // Sync live query results to the Zustand store cache when available
  useEffect(() => {
    if (!liveQueryEnabled || loading) {
      return;
    }
    // Only update cache if we have real data (not just an empty array from initial state)
    if (collections.length > 0 || cachedCollections.length > 0) {
      setCachedCollections(collections);
    }
  }, [cachedCollections.length, collections, liveQueryEnabled, loading, setCachedCollections]);

  // Initial fetch: ALWAYS runs once when db and schema are ready, regardless of embedding state.
  // This ensures collections load at least once. The live query provides real-time updates afterward.
  // Performance note: A single fetch is fine; we only disable live queries (which fire on every
  // mutation) during bulk operations, not one-time queries.
  useEffect(() => {
    const canQuery = Boolean(db && typeof (db as { query?: unknown }).query === 'function');
    const shouldFetch =
      schemaVerified && // Wait for schema to be ready (tables exist)
      canQuery &&
      !fetchState.loading &&
      !initialFetchedRef.current;
    if (!shouldFetch) {
      return;
    }

    let cancelled = false;
    initialFetchedRef.current = true;

    const fetchOnce = async () => {
      if (!cancelled) {
        dispatchFetch({ type: 'start' });
      }
      try {
        const result = await (
          db as { query: (query: string) => Promise<{ rows: CollectionRow[] }> }
        ).query(COLLECTIONS_QUERY);
        if (!cancelled) {
          setCachedCollections(normalizeCollectionRows(result.rows));
          dispatchFetch({ type: 'success' });
        }
      } catch (err) {
        if (!cancelled) {
          const normalized = err instanceof Error ? err : new Error(String(err));
          // Reset flag on error so we can retry when conditions change
          initialFetchedRef.current = false;
          dispatchFetch({ type: 'error', error: normalized });
        }
      }
    };

    void fetchOnce();

    return () => {
      cancelled = true;
    };
  }, [db, schemaVerified, setCachedCollections]);

  // Reset initial fetch flag when db changes (e.g., reconnection)
  useEffect(() => {
    initialFetchedRef.current = false;
  }, [db]);

  // Return live data when enabled, otherwise return cached data from Zustand store
  // Use initial loading/error state when live query is disabled
  return {
    collections: liveQueryEnabled ? collections : cachedCollections,
    loading: liveQueryEnabled ? loading : fetchState.loading,
    error: liveQueryEnabled ? error : fetchState.error,
  };
}

/**
 * Format collection label with name, file count, and embedding progress
 *
 * Shows: "Collection Name (N files)" when no chunks exist
 * Shows: "Collection Name (N files · 45/100 embedded)" when chunks exist
 */
export function formatCollectionLabel(collection: CollectionWithDocCount): string {
  const name = collection.name || collection.modelId;
  const fileCount = collection.fileCount;
  const filesLabel = fileCount === 1 ? 'file' : 'files';
  const filesPart = `${fileCount.toLocaleString()} ${filesLabel}`;

  // Show embedding progress if there are chunks
  if (collection.chunkCount > 0) {
    const embedded = collection.embeddingCount;
    const total = collection.chunkCount;
    return `${name} (${filesPart} · ${embedded}/${total} embedded)`;
  }

  return `${name} (${filesPart})`;
}

/**
 * CollectionSelect - Shared base component for selecting embedding collections
 *
 * This is the core select dropdown used by both:
 * - SearchCollectionSelector (db-explorer) - with additional UI chrome
 * - EmbeddingSetSelector (vector-management) - compact version for Vector Status
 *
 * Features:
 * - Live query for real-time collection updates (when db provided without collections)
 * - Accepts pre-fetched collections to avoid duplicate queries
 * - Configurable size (compact/default)
 * - Customizable placeholders
 * - Error callback for parent handling
 */
export function CollectionSelect({
  db,
  selectedId,
  onSelectionChange,
  size = 'default',
  placeholder = 'Select collection',
  loadingPlaceholder = 'Loading...',
  onError,
  triggerClassName,
  contentClassName,
  emptyState,
  collections: externalCollections,
  loading: externalLoading,
  error: externalError,
}: CollectionSelectProps) {
  // Resolve collection data from external props or internal fetch
  const { collections, loading, error, shouldFetchInternally } = useResolvedCollectionData(
    db,
    externalCollections,
    externalLoading,
    externalError
  );

  // Report errors to parent (only once per unique error)
  useErrorReporting(error, onError);

  const handleChange = useCallback(
    (value: string) => {
      onSelectionChange(value || null);
    },
    [onSelectionChange]
  );

  const selectedCollection = useMemo(
    () => collections.find((c) => c.id === selectedId) ?? null,
    [collections, selectedId]
  );
  const hasCollections = collections.length > 0;
  // When external collections are provided, don't check db for loading state
  const isLoading = loading || (shouldFetchInternally && !db);
  const styles = SIZE_STYLES[size];

  // Show empty state when no collections and not loading
  if (!(hasCollections || isLoading) && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <Select
      disabled={!hasCollections || isLoading}
      onValueChange={handleChange}
      value={selectedId ?? ''}
    >
      <SelectTrigger className={`w-full ${styles.trigger} ${triggerClassName ?? ''}`.trim()}>
        <SelectValue placeholder={isLoading ? loadingPlaceholder : placeholder}>
          {selectedCollection ? formatCollectionLabel(selectedCollection) : null}
        </SelectValue>
      </SelectTrigger>
      {hasCollections && (
        <SelectContent className={`${styles.content} ${contentClassName ?? ''}`.trim()}>
          {collections.map((collection) => (
            <SelectItem className={styles.item} key={collection.id} value={collection.id}>
              {formatCollectionLabel(collection)}
            </SelectItem>
          ))}
        </SelectContent>
      )}
    </Select>
  );
}
