import type { usePGliteDatabase } from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Row shape returned by the collections query
 */
export type CollectionRow = {
  id: string;
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: string;
  createdAt: string;
  name: string | null;
  description: string | null;
  tags: string | null;
  category: string | null;
  fileCount: string | number;
  chunkCount: string | number;
  embeddingCount: string | number;
};

/**
 * Normalized collection data with file count
 *
 * Terminology:
 * - fileCount: Number of imported files (file_records) in this collection
 * - chunkCount: Number of chunks (file_chunks) in this collection
 * - embeddingCount: Number of chunks with embeddings in this collection
 */
export type CollectionWithDocCount = {
  id: string;
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  createdAt: string;
  name: string | null;
  description: string | null;
  tags: string | null;
  category: string | null;
  /** Number of files imported into this collection */
  fileCount: number;
  /** Number of chunks in this collection */
  chunkCount: number;
  /** Number of embeddings in this collection */
  embeddingCount: number;
};

/**
 * SQL query to fetch all embedding sets with their file counts.
 * Uses LEFT JOIN to include collections with zero files.
 */
const COLLECTIONS_QUERY = `
    WITH file_counts AS (
      SELECT embedding_set_id, COUNT(*)::int AS "fileCount"
        FROM file_records
       GROUP BY embedding_set_id
    ),
    chunk_counts AS (
      SELECT
        embedding_set_id,
        COUNT(*)::int AS "chunkCount",
        COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS "embeddingCount"
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
      COALESCE(f."fileCount", 0) AS "fileCount",
      COALESCE(c."chunkCount", 0) AS "chunkCount",
      COALESCE(c."embeddingCount", 0) AS "embeddingCount"
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

export type CollectionSelectProps = {
  /**
   * Database instance for querying collections.
   * Required if collections/loading/error are not provided (will fetch internally).
   * Ignored if collections are provided externally.
   */
  db?: ReturnType<typeof usePGliteDatabase>;

  /**
   * Currently selected collection ID
   */
  selectedId: string | null;

  /**
   * Callback when selection changes
   */
  onSelectionChange: (id: string | null) => void;

  /**
   * Size variant - 'compact' for tight spaces like Vector Status,
   * 'default' for full-size like Database Explorer
   */
  size?: CollectionSelectSize;

  /**
   * Placeholder text when no collection is selected
   */
  placeholder?: string;

  /**
   * Placeholder text when loading
   */
  loadingPlaceholder?: string;

  /**
   * Optional callback when an error occurs loading collections
   */
  onError?: (error: Error) => void;

  /**
   * Additional className for the trigger
   */
  triggerClassName?: string;

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
   * Pre-fetched collections data. If provided, skips internal useCollections hook.
   * Use this to avoid duplicate queries when parent already has the data.
   */
  collections?: CollectionWithDocCount[];

  /**
   * Loading state (used when collections are provided externally)
   */
  loading?: boolean;

  /**
   * Error state (used when collections are provided externally)
   */
  error?: Error | null;
};

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
export function useCollections(db: ReturnType<typeof usePGliteDatabase> | null | undefined) {
  const isImporting = useVectorStatusUIStore((s) => s.isImporting);
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);
  const liveQueryEnabled = Boolean(db) && !isImporting && !isEmbeddingActive;
  const {
    rows: rawCollections,
    loading,
    error,
  } = usePGliteLiveQuery<CollectionRow>({
    query: COLLECTIONS_QUERY,
    enabled: liveQueryEnabled,
  });

  const collections = useMemo<CollectionWithDocCount[]>(
    () =>
      rawCollections.map((row) => ({
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
      })),
    [rawCollections]
  );

  const snapshotRef = useRef<CollectionWithDocCount[]>([]);
  if (liveQueryEnabled) {
    snapshotRef.current = collections;
  }

  return {
    collections: liveQueryEnabled ? collections : snapshotRef.current,
    loading: liveQueryEnabled ? loading : false,
    error: liveQueryEnabled ? error : null,
  };
}

/**
 * Format collection label with name and file count
 *
 * Shows: "Collection Name (N files)" where N is the number of imported files.
 * For chunk/embedding coverage, see Vector Status panel.
 */
export function formatCollectionLabel(collection: CollectionWithDocCount): string {
  const name = collection.name || collection.modelId;
  const count = collection.fileCount;
  const filesLabel = count === 1 ? 'file' : 'files';
  return `${name} (${count.toLocaleString()} ${filesLabel})`;
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
