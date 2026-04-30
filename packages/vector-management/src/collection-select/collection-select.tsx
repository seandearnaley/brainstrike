import type { usePGliteDatabase } from '@brainstrike/db';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db';
import {
  compareCollectionsDesc,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { EmbeddingSetUpdatedEventDetail } from './embedding-set-events';

/**
 * Row shape returned by the collections query
 */
export interface CollectionRow {
  category: string | null;
  chunkCount: null | string | number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: string;
  embeddingCount: null | string | number;
  fileCount: null | string | number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  statsAvailable?: boolean | string;
  statsLastRefreshedAt?: string | null;
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
  statsAvailable?: boolean;
  statsLastRefreshedAt?: string | null;
  tags: string | null;
}

/**
 * SQL query to fetch all embedding sets with their file counts.
 * Uses LEFT JOIN to include collections with zero files.
 */
const COLLECTIONS_QUERY = `
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
      stats.file_count AS "fileCount",
      stats.chunk_count AS "chunkCount",
      stats.embedded_chunk_count AS "embeddingCount",
      stats.last_refreshed_at AS "statsLastRefreshedAt",
      stats.embedding_set_id IS NOT NULL AS "statsAvailable"
    FROM embedding_sets s
    LEFT JOIN collection_indexing_stats stats ON stats.embedding_set_id = s.id
    ORDER BY s.created_at DESC, s.id DESC
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
    statsAvailable:
      row.statsAvailable === undefined
        ? true
        : row.statsAvailable === true || row.statsAvailable === 'true',
    statsLastRefreshedAt: row.statsLastRefreshedAt ?? null,
  }));
}

function mergeCollections(
  liveCollections: CollectionWithDocCount[],
  cachedCollections: CollectionWithDocCount[]
): CollectionWithDocCount[] {
  const merged = new Map<string, CollectionWithDocCount>();
  for (const collection of cachedCollections) {
    merged.set(collection.id, collection);
  }
  for (const collection of liveCollections) {
    merged.set(collection.id, collection);
  }
  return Array.from(merged.values()).sort(compareCollectionsDesc);
}

function upsertCollectionSnapshot(
  collections: CollectionWithDocCount[],
  collection: CollectionWithDocCount
): CollectionWithDocCount[] {
  const next = collections.filter((candidate) => candidate.id !== collection.id);
  next.unshift(collection);
  next.sort(compareCollectionsDesc);
  return next;
}

type PendingCollectionMutationReason = 'created' | 'deleted' | 'updated';

function applyPendingCollectionMutations(
  liveCollections: CollectionWithDocCount[],
  cachedCollections: CollectionWithDocCount[],
  pendingMutations: ReadonlyMap<string, PendingCollectionMutationReason>
): CollectionWithDocCount[] {
  const merged = new Map<string, CollectionWithDocCount>(
    liveCollections.map((collection) => [collection.id, collection])
  );

  for (const [collectionId, reason] of pendingMutations) {
    if (reason === 'deleted') {
      merged.delete(collectionId);
      continue;
    }
    const cachedCollection = cachedCollections.find((candidate) => candidate.id === collectionId);
    if (cachedCollection) {
      merged.set(collectionId, cachedCollection);
    }
  }

  return Array.from(merged.values()).sort(compareCollectionsDesc);
}

function clearSatisfiedPendingCollectionMutations(
  liveCollections: CollectionWithDocCount[],
  pendingMutations: Map<string, PendingCollectionMutationReason>
): void {
  for (const [collectionId, reason] of pendingMutations.entries()) {
    const liveHasCollection = liveCollections.some((collection) => collection.id === collectionId);
    if (reason === 'deleted') {
      if (!liveHasCollection) {
        pendingMutations.delete(collectionId);
      }
      continue;
    }
    if (liveHasCollection) {
      pendingMutations.delete(collectionId);
    }
  }
}

function areCollectionsEqual(
  left: readonly CollectionWithDocCount[],
  right: readonly CollectionWithDocCount[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCollection = left[index];
    const rightCollection = right[index];
    const leftStatsAvailable = leftCollection?.statsAvailable ?? true;
    const rightStatsAvailable = rightCollection?.statsAvailable ?? true;
    const leftStatsLastRefreshedAt = leftCollection?.statsLastRefreshedAt ?? null;
    const rightStatsLastRefreshedAt = rightCollection?.statsLastRefreshedAt ?? null;
    if (
      !(leftCollection && rightCollection) ||
      leftCollection.id !== rightCollection.id ||
      leftCollection.modelKey !== rightCollection.modelKey ||
      leftCollection.modelId !== rightCollection.modelId ||
      leftCollection.dimensions !== rightCollection.dimensions ||
      leftCollection.distance !== rightCollection.distance ||
      leftCollection.createdAt !== rightCollection.createdAt ||
      leftCollection.name !== rightCollection.name ||
      leftCollection.description !== rightCollection.description ||
      leftCollection.tags !== rightCollection.tags ||
      leftCollection.category !== rightCollection.category ||
      leftCollection.fileCount !== rightCollection.fileCount ||
      leftCollection.chunkCount !== rightCollection.chunkCount ||
      leftCollection.embeddingCount !== rightCollection.embeddingCount ||
      leftStatsAvailable !== rightStatsAvailable ||
      leftStatsLastRefreshedAt !== rightStatsLastRefreshedAt
    ) {
      return false;
    }
  }
  return true;
}

export function useCollections(db: ReturnType<typeof usePGliteDatabase> | null | undefined) {
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const schemaVerified = useVectorStatusUIStore((s) => s.schemaVerified);
  // Use Zustand store for caching - persists across component unmounts during bulk operations
  const cachedCollections = useVectorStatusUIStore((s) => s.cachedCollections);
  const setCachedCollections = useVectorStatusUIStore((s) => s.setCachedCollections);
  const upsertCachedCollection = useVectorStatusUIStore((s) => s.upsertCachedCollection);
  const removeCachedCollection = useVectorStatusUIStore((s) => s.removeCachedCollection);
  const cachedCollectionsRef = useRef(cachedCollections);
  const pendingMutationsRef = useRef(new Map<string, PendingCollectionMutationReason>());
  cachedCollectionsRef.current = cachedCollections;
  // Only enable live queries when:
  // 1. Database is available
  // 2. Schema has been verified (migrations completed, tables exist)
  // 3. Not currently importing files
  //
  // Background embedding must not detach foreground collection updates: the
  // collection selector is the user's navigation surface while indexing runs.
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
    mode: 'incremental',
    key: 'id',
    enabled: liveQueryEnabled,
  });

  const refreshCollectionsSnapshot = useCallback(async () => {
    const canQuery = Boolean(db && typeof (db as { query?: unknown }).query === 'function');
    if (!(schemaVerified && canQuery)) {
      return;
    }
    try {
      const result = await (
        db as { query: (query: string) => Promise<{ rows: CollectionRow[] }> }
      ).query(COLLECTIONS_QUERY);
      const normalizedRows = normalizeCollectionRows(result.rows);
      clearSatisfiedPendingCollectionMutations(normalizedRows, pendingMutationsRef.current);
      const nextCollections = applyPendingCollectionMutations(
        normalizedRows,
        cachedCollectionsRef.current,
        pendingMutationsRef.current
      );
      if (!areCollectionsEqual(nextCollections, cachedCollectionsRef.current)) {
        cachedCollectionsRef.current = nextCollections;
        setCachedCollections(nextCollections);
      }
      dispatchFetch({ type: 'success' });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      dispatchFetch({ type: 'error', error: normalized });
      throw normalized;
    }
  }, [db, schemaVerified, setCachedCollections]);

  // Listen for embedding set update events (create/delete/rename) and refresh live query
  // This ensures UI updates on Electron where PGlite live query may not auto-detect changes
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleEmbeddingSetUpdated = (event: Event) => {
      const detail = (event as CustomEvent<EmbeddingSetUpdatedEventDetail>).detail;
      if (detail?.reason === 'deleted' && detail.id) {
        pendingMutationsRef.current.set(detail.id, 'deleted');
        cachedCollectionsRef.current = cachedCollectionsRef.current.filter(
          (collection) => collection.id !== detail.id
        );
        removeCachedCollection(detail.id);
      } else if (detail?.collection) {
        if (detail.reason === 'created' || detail.reason === 'updated') {
          pendingMutationsRef.current.set(detail.collection.id, detail.reason);
        }
        cachedCollectionsRef.current = upsertCollectionSnapshot(
          cachedCollectionsRef.current,
          detail.collection
        );
        upsertCachedCollection(detail.collection);
      }
      if (liveQueryEnabled) {
        void refresh();
      }
      void refreshCollectionsSnapshot();
    };

    window.addEventListener('brainstrike:embedding-set-updated', handleEmbeddingSetUpdated);

    return () => {
      window.removeEventListener('brainstrike:embedding-set-updated', handleEmbeddingSetUpdated);
    };
  }, [
    liveQueryEnabled,
    refresh,
    refreshCollectionsSnapshot,
    removeCachedCollection,
    upsertCachedCollection,
  ]);

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
    if (typeof window === 'undefined') {
      return;
    }

    const handleQueueDrained = () => {
      if (liveQueryEnabled) {
        void refresh();
      }
      void refreshCollectionsSnapshot();
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [liveQueryEnabled, refresh, refreshCollectionsSnapshot]);

  const collections = useMemo<CollectionWithDocCount[]>(
    () => normalizeCollectionRows(rawCollections),
    [rawCollections]
  );

  const resolvedCollections = useMemo(() => {
    if (!liveQueryEnabled) {
      return cachedCollections;
    }
    if (loading) {
      return mergeCollections(collections, cachedCollections);
    }
    return applyPendingCollectionMutations(
      collections,
      cachedCollections,
      pendingMutationsRef.current
    );
  }, [cachedCollections, collections, liveQueryEnabled, loading]);

  // Sync live query results to the Zustand store cache when available
  useEffect(() => {
    if (!liveQueryEnabled || loading) {
      return;
    }
    clearSatisfiedPendingCollectionMutations(collections, pendingMutationsRef.current);
    if (collections.length === 0 && cachedCollections.length === 0) {
      return;
    }
    const nextCollections = applyPendingCollectionMutations(
      collections,
      cachedCollectionsRef.current,
      pendingMutationsRef.current
    );
    if (areCollectionsEqual(nextCollections, cachedCollectionsRef.current)) {
      return;
    }
    cachedCollectionsRef.current = nextCollections;
    setCachedCollections(nextCollections);
  }, [cachedCollections, collections, liveQueryEnabled, loading, setCachedCollections]);

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
        await refreshCollectionsSnapshot();
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
  }, [db, refreshCollectionsSnapshot, schemaVerified]);

  // Reset initial fetch flag when db changes (e.g., reconnection)
  useEffect(() => {
    initialFetchedRef.current = false;
  }, [db]);

  // Return live data when enabled, otherwise return cached data from Zustand store
  // Use initial loading/error state when live query is disabled
  return {
    collections: resolvedCollections,
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
  if (collection.statsAvailable === false) {
    return `${name} (stats pending)`;
  }
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
