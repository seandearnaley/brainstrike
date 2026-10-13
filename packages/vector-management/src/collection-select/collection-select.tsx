import {
  compareCollectionsDesc,
  useVectorStatusUIStore,
} from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import {
  type BoundaryTransport,
  createBoundaryCapability,
} from '@brainstrike/assistant-contract/boundary-result';
import type { EmbeddingSetSystemRole } from '@brainstrike/db';
import type { usePGliteDatabase } from '@brainstrike/db/react';
import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  getCollectionPickerProtection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import {
  type EmbeddingSetUpdatedEventDetail,
  onEmbeddingSetUpdated,
  onQueueDrained,
} from '@brainstrike/utils/browser-events';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { canonicalizeCollectionTimestamps, normalizeTimestamp } from './collection-timestamps';

/**
 * Row shape returned by the collections query
 */
export interface CollectionRow {
  category: string | null;
  chunkCount: null | string | number;
  /** `timestamptz`; PGlite yields a `Date`. See {@link normalizeTimestamp}. */
  createdAt: string | Date;
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
  /** `timestamptz`; PGlite yields a `Date`. See {@link normalizeTimestamp}. */
  statsLastRefreshedAt?: string | Date | null;
  systemRole?: EmbeddingSetSystemRole | null;
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
  systemRole?: EmbeddingSetSystemRole | null;
  tags: string | null;
  vectorStatsUnavailableReason?: string;
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
      s.system_role AS "systemRole",
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
    content: 'max-w-[300px]',
    item: 'text-xs',
    trigger: 'h-7 text-[10px]',
  },
  default: {
    content: 'max-w-[400px]',
    item: '',
    trigger: '',
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
    error: externalError ?? internalData.error,
    loading: externalLoading ?? internalData.loading,
    shouldFetchInternally,
  };
}

/**
 * Hook to fetch and normalize collection data
 */
function normalizeCollectionRows(rows: CollectionRow[]): CollectionWithDocCount[] {
  return rows.map((row) => ({
    category: row.category,
    chunkCount: Number(row.chunkCount ?? 0),
    // `createdAt` is non-nullable, so it is narrowed inline rather than through
    // normalizeTimestamp — nothing here may invent a missing timestamp.
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    description: row.description,
    dimensions: row.dimensions,
    distance: row.distance as 'cosine' | 'l2' | 'ip',
    embeddingCount: Number(row.embeddingCount ?? 0),
    fileCount: Number(row.fileCount ?? 0),
    id: row.id,
    modelId: row.modelId,
    modelKey: row.modelKey,
    name: row.name,
    statsAvailable:
      row.statsAvailable === undefined
        ? true
        : row.statsAvailable === true || row.statsAvailable === 'true',
    statsLastRefreshedAt: normalizeTimestamp(row.statsLastRefreshedAt),
    systemRole: row.systemRole ?? null,
    tags: row.tags,
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
      (leftCollection.systemRole ?? null) !== (rightCollection.systemRole ?? null) ||
      leftCollection.fileCount !== rightCollection.fileCount ||
      leftCollection.chunkCount !== rightCollection.chunkCount ||
      leftCollection.embeddingCount !== rightCollection.embeddingCount ||
      leftCollection.vectorStatsUnavailableReason !==
        rightCollection.vectorStatsUnavailableReason ||
      leftStatsAvailable !== rightStatsAvailable ||
      leftStatsLastRefreshedAt !== rightStatsLastRefreshedAt
    ) {
      return false;
    }
  }
  return true;
}

function getCollectionCatalog(): CollectionCatalogCapability | undefined {
  const transport =
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { collectionCatalog?: BoundaryTransport<CollectionCatalogCapability> })
          .collectionCatalog;
  return transport ? createBoundaryCapability<CollectionCatalogCapability>(transport) : undefined;
}

/**
 * One-shot read of the collections projection.
 *
 * Exists so read-only surfaces (a transient picker) can show collections
 * WITHOUT mounting a second `useCollections`. Two live instances both write the
 * shared `cachedCollections` cache after applying their OWN pending mutations,
 * so they ping-pong the store forever once those diverge (React "maximum update
 * depth"). Exactly one `useCollections` may be mounted at a time.
 */
export async function fetchCollectionsSnapshot(
  db: ReturnType<typeof usePGliteDatabase>
): Promise<CollectionWithDocCount[]> {
  const catalog = getCollectionCatalog();
  if (catalog) {
    const entries = await catalog.snapshot();
    return entries
      .map(
        (entry): CollectionWithDocCount => ({
          ...entry,
          category: entry.category ?? null,
          chunkCount: entry.counts.chunks,
          description: entry.description ?? null,
          // Existing cache count is only meaningful when statsAvailable is true.
          embeddingCount: entry.vectors.kind === 'available' ? entry.vectors.count : 0,
          fileCount: entry.counts.files,
          name: entry.name ?? null,
          statsAvailable: entry.vectors.kind === 'available',
          tags: entry.tags ?? null,
          ...(entry.vectors.kind === 'unavailable'
            ? { vectorStatsUnavailableReason: entry.vectors.reason }
            : {}),
          statsLastRefreshedAt: null,
        })
      )
      .sort(compareCollectionsDesc);
  }
  // NO SILENT FALLBACKS: an empty array here is indistinguishable from "this
  // workspace has no collections", which reads to the user as an invitation to
  // create a duplicate. An unusable handle is a programming error - throw.
  if (!(db && typeof (db as { query?: unknown }).query === 'function')) {
    throw new Error(
      'fetchCollectionsSnapshot requires an initialized database handle exposing query().'
    );
  }
  const result = await (
    db as { query: (query: string) => Promise<{ rows: CollectionRow[] }> }
  ).query(COLLECTIONS_QUERY);
  return normalizeCollectionRows(result.rows);
}

/**
 * Live collections projection, backed by a PGlite live query.
 *
 * ⚠️ MOUNT AT MOST ONE INSTANCE AT A TIME (settled BST-1212 — do not
 * relitigate). This hook does not just READ the shared
 * `vectorStatusUIStore.cachedCollections` cache, it WRITES it, after applying
 * its own instance-local `pendingMutationsRef`. Two mounted instances whose
 * pending mutations differ compute different "next" caches from each other's
 * writes and never converge: A writes X, B recomputes Y and writes it, A
 * recomputes X... The render loop ends with React's "maximum update depth"
 * (#185), which in practice killed the whole surrounding panel.
 *
 * A second surface that only needs to DISPLAY collections must read
 * `cachedCollections` and, if it may be the first surface up, seed it with the
 * one-shot `fetchCollectionsSnapshot` — see
 * `packages/db-explorer/src/components/explorer-collection-picker.tsx`. Keeping
 * the shared cache current across create/rename/delete is the
 * `onEmbeddingSetUpdated` contract, not a reason to mount a second live query.
 */
export function useCollections(db: ReturnType<typeof usePGliteDatabase> | null | undefined) {
  const catalog = getCollectionCatalog();
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
  const liveQueryEnabled = !catalog && Boolean(db) && schemaVerified && !isImporting;
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
          return { error: null, loading: true };
        case 'success':
          return { error: null, loading: false };
        case 'error':
          return { error: action.error, loading: false };
        case 'reset':
          return { error: null, loading: false };
      }
    },
    { error: null, loading: false }
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
    enabled: liveQueryEnabled,
    key: 'id',
    mode: 'incremental',
    query: COLLECTIONS_QUERY,
  });

  const refreshCollectionsSnapshot = useCallback(async () => {
    const canQuery = Boolean(db && typeof (db as { query?: unknown }).query === 'function');
    if (!(catalog || (schemaVerified && canQuery))) {
      return;
    }
    try {
      const normalizedRows = await fetchCollectionsSnapshot(db ?? null);
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
      dispatchFetch({ error: normalized, type: 'error' });
      throw normalized;
    }
  }, [catalog, db, schemaVerified, setCachedCollections]);

  // Listen for embedding set update events (create/delete/rename) and refresh live query
  // This ensures UI updates on Electron where PGlite live query may not auto-detect changes
  useEffect(() => {
    const handleEmbeddingSetUpdated = (detail: EmbeddingSetUpdatedEventDetail | null) => {
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
        // Second ingress into the shared cache. It must land in the same
        // timestamp form as the query path or the two sort against each other.
        const eventCollection = canonicalizeCollectionTimestamps(detail.collection);
        cachedCollectionsRef.current = upsertCollectionSnapshot(
          cachedCollectionsRef.current,
          eventCollection
        );
        upsertCachedCollection(eventCollection);
      }
      if (liveQueryEnabled) {
        void refresh();
      }
      void refreshCollectionsSnapshot();
    };

    return onEmbeddingSetUpdated(handleEmbeddingSetUpdated);
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
    const handleQueueDrained = () => {
      if (liveQueryEnabled) {
        void refresh();
      }
      void refreshCollectionsSnapshot();
    };

    return onQueueDrained(handleQueueDrained);
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
      (catalog || (schemaVerified && canQuery)) &&
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
          dispatchFetch({ error: normalized, type: 'error' });
        }
      }
    };

    void fetchOnce();

    return () => {
      cancelled = true;
    };
  }, [catalog, db, refreshCollectionsSnapshot, schemaVerified]);

  // Reset initial fetch flag when db changes (e.g., reconnection)
  useEffect(() => {
    initialFetchedRef.current = false;
  }, [catalog, db]);

  // Return live data when enabled, otherwise return cached data from Zustand store
  // Use initial loading/error state when live query is disabled
  return {
    collections: resolvedCollections,
    error: liveQueryEnabled ? error : fetchState.error,
    loading: liveQueryEnabled ? loading : fetchState.loading,
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
  if (collection.vectorStatsUnavailableReason) {
    return `${name} (${collection.fileCount.toLocaleString()} ${collection.fileCount === 1 ? 'file' : 'files'} · vectors unavailable)`;
  }
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
      const collection = collections.find((candidate) => candidate.id === value);
      if (collection && getCollectionPickerProtection(collection).isDisabled) {
        return;
      }
      onSelectionChange(value || null);
    },
    [collections, onSelectionChange]
  );

  const selectedCollection = useMemo(
    () =>
      collections.find(
        (collection) =>
          collection.id === selectedId && !getCollectionPickerProtection(collection).isDisabled
      ) ?? null,
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
      value={selectedCollection?.id ?? ''}
    >
      <SelectTrigger className={`w-full ${styles.trigger} ${triggerClassName ?? ''}`.trim()}>
        <SelectValue placeholder={isLoading ? loadingPlaceholder : placeholder}>
          {selectedCollection ? formatCollectionLabel(selectedCollection) : null}
        </SelectValue>
      </SelectTrigger>
      {hasCollections && (
        <SelectContent className={`${styles.content} ${contentClassName ?? ''}`.trim()}>
          {collections.map((collection) => (
            <SelectItem
              className={styles.item}
              disabled={getCollectionPickerProtection(collection).isDisabled}
              key={collection.id}
              value={collection.id}
            >
              {formatCollectionLabel(collection)}
            </SelectItem>
          ))}
        </SelectContent>
      )}
    </Select>
  );
}
