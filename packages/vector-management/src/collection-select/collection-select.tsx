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
import { canonicalizeCollectionTimestamps } from './collection-timestamps';

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
  externalCollections?: CollectionWithDocCount[],
  externalLoading?: boolean,
  externalError?: Error | null
) {
  const shouldFetchInternally = externalCollections === undefined;
  const internalData = useCollections();

  return {
    collections: externalCollections ?? internalData.collections,
    error: externalError ?? internalData.error,
    loading: externalLoading ?? internalData.loading,
    shouldFetchInternally,
    sourceReady: internalData.sourceReady,
  };
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
export async function fetchCollectionsSnapshot(): Promise<CollectionWithDocCount[]> {
  const catalog = getCollectionCatalog();
  // NO SILENT FALLBACKS: an empty array here is indistinguishable from "this
  // workspace has no collections", which reads to the user as an invitation to
  // create a duplicate. A missing catalog is a programming error - throw.
  if (!catalog) {
    throw new Error('fetchCollectionsSnapshot requires the collection catalog capability.');
  }
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

/**
 * Collections projection, read from the native collection catalog.
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
 * `onEmbeddingSetUpdated` contract, not a reason to mount a second reader.
 */
export function useCollections() {
  const catalog = getCollectionCatalog();
  // Use Zustand store for caching - persists across component unmounts during bulk operations
  const cachedCollections = useVectorStatusUIStore((s) => s.cachedCollections);
  const setCachedCollections = useVectorStatusUIStore((s) => s.setCachedCollections);
  const upsertCachedCollection = useVectorStatusUIStore((s) => s.upsertCachedCollection);
  const removeCachedCollection = useVectorStatusUIStore((s) => s.removeCachedCollection);
  const cachedCollectionsRef = useRef(cachedCollections);
  const pendingMutationsRef = useRef(new Map<string, PendingCollectionMutationReason>());
  cachedCollectionsRef.current = cachedCollections;
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
  // Track if we've done the initial fetch
  const initialFetchedRef = useRef(false);

  const refreshCollectionsSnapshot = useCallback(async () => {
    if (!catalog) {
      return;
    }
    try {
      const normalizedRows = await fetchCollectionsSnapshot();
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
  }, [catalog, setCachedCollections]);

  // Listen for embedding set update events (create/delete/rename) and refresh the snapshot
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
        // timestamp form as the snapshot path or the two sort against each other.
        const eventCollection = canonicalizeCollectionTimestamps(detail.collection);
        cachedCollectionsRef.current = upsertCollectionSnapshot(
          cachedCollectionsRef.current,
          eventCollection
        );
        upsertCachedCollection(eventCollection);
      }
      void refreshCollectionsSnapshot();
    };

    return onEmbeddingSetUpdated(handleEmbeddingSetUpdated);
  }, [refreshCollectionsSnapshot, removeCachedCollection, upsertCachedCollection]);

  useEffect(() => {
    const handleQueueDrained = () => {
      void refreshCollectionsSnapshot();
    };

    return onQueueDrained(handleQueueDrained);
  }, [refreshCollectionsSnapshot]);

  // Initial fetch: ALWAYS runs once when the catalog is available, regardless of embedding state.
  useEffect(() => {
    const shouldFetch = catalog && !fetchState.loading && !initialFetchedRef.current;
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
  }, [catalog, refreshCollectionsSnapshot]);

  // Reset initial fetch flag when the catalog changes
  useEffect(() => {
    initialFetchedRef.current = false;
  }, [catalog]);

  return {
    collections: cachedCollections,
    error: fetchState.error,
    loading: fetchState.loading,
    sourceReady: Boolean(catalog),
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
 *
 * Features:
 * - Native catalog read for collection updates (when collections are not provided)
 * - Accepts pre-fetched collections to avoid duplicate queries
 * - Configurable size (compact/default)
 * - Customizable placeholders
 * - Error callback for parent handling
 */
export function CollectionSelect({
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
  const { collections, loading, error, shouldFetchInternally, sourceReady } =
    useResolvedCollectionData(externalCollections, externalLoading, externalError);

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
  // When external collections are provided, don't check the catalog for loading state
  const isLoading = loading || (shouldFetchInternally && !sourceReady);
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
