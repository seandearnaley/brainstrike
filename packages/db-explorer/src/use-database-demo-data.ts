import {
  ACTIVE_COLLECTION_LIVE_COUNTS_QUERY,
  type DbHandle,
  type FileChunk,
  type FileRecord,
  type IFileRecordRepository,
  makeLiveQueryKey,
  useBrainstrikeLiveQuery,
} from '@brainstrike/db';
import { useDatabaseStatusStore } from '@brainstrike/preferences/stores/database-status-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildCollectionFileDataSnapshot,
  buildRecordPageCacheKey,
  type CollectionCountsRow,
  cacheCollectionCountsForCollection,
  cacheTotalRecordsForCollection,
  collectionCountsRowBelongsToCollection,
  countLoadedChunkGroups,
  countLoadedChunks,
  extractErrorMessage,
  type FileChunkRow,
  type FileRecordRow,
  type FileRecordsTotalRow,
  isMissingRelation,
  mapChunkRow,
  mapCollectionCountsRow,
  mapRecordRow,
  normalizeCount,
  recordsBelongToCollection,
  restoreCachedChunkGroups,
  restoreCachedRecord,
  rowBelongsToCollection,
} from './database-demo-data-mappers';

const logger = createLogger('DatabaseDemoData');

/**
 * Resolve the storage location label based on the repository type.
 * This must match the expected values in database-status-item.tsx for proper status bar display.
 * - "Main Process" → displays as "IPC" in status bar
 * - "PGlite WASM" → displays as "PGlite WASM" in status bar
 * - "Turso" → displays as "Turso" in status bar
 */
function resolveStorageLocation(
  repository: IFileRecordRepository | null,
  databaseRuntimeEngine?: string | null
): string {
  if (databaseRuntimeEngine === 'turso') {
    return 'Turso';
  }
  if (!repository) {
    return 'Unknown';
  }
  // Check repository constructor name to determine if it's the Electron IPC repository
  // This approach works even when ElectronFileRecordRepository is imported as a type
  if (repository.constructor.name === 'ElectronFileRecordRepository') {
    return 'Main Process';
  }
  return 'PGlite WASM';
}

export interface DatabaseInfo {
  connected: boolean;
  location: string;
  testResult: string;
}

interface DatabaseDemoChunkRepository {
  readonly findByFileRecordId?: (fileRecordId: string) => Promise<FileChunk[]>;
  readonly findById?: (chunkId: string) => Promise<FileChunk | null>;
}

export interface UseDatabaseDemoDataOptions {
  activeCollectionId: string | null;
  chunkRepository?: DatabaseDemoChunkRepository | null;
  database?: DbHandle | null;
  /** Selected database engine, used for diagnostics labels and engine-specific probes. */
  databaseRuntimeEngine?: string | null;
  /** When true, diagnostics can reflect active embedding pressure. Collection reads remain live. */
  isEmbeddingActive?: boolean;
  /** When true, live queries are paused to avoid performance degradation during bulk operations */
  isImporting?: boolean;
  /** Zero-based page index for the active collection file list. */
  recordPage?: number;
  /** Bounded page size for the active collection file list. */
  recordPageSize?: number;
  repository: IFileRecordRepository | null;
  /** False when the current DB surface cannot execute the PGlite/Postgres collection-browser SQL. */
  supportsPGliteCollectionQueries?: boolean;
  toast: ReturnType<typeof useToast>['toast'];
}

interface DatabaseLoaders {
  loadChunkDetail: (chunkId: string) => Promise<FileChunk | null>;
  loadChunks: () => Promise<void>;
  loadCollectionExportData: () => Promise<{
    chunks: FileChunk[];
    records: FileRecord[];
  }>;
  loadFileChunkSummaries: (fileRecordId: string) => Promise<DatabaseFileChunkSummary[]>;
  loadRecords: () => Promise<void>;
}

export interface DatabaseFileRecordSummary {
  chunkingStrategy?: FileRecord['chunkingStrategy'];
  chunksCount?: number;
  chunksProcessedAt?: string;
  contentHash?: string;
  createdAt: string;
  embeddedChunksCount?: number;
  embeddingSetId?: string;
  hasEmbedding?: boolean;
  id: string;
  name: string;
  path: string;
  processedAt?: string;
  size: number;
  tokenCount?: number;
  updatedAt: string;
}

export interface DatabaseFileChunkSummary {
  chunkIndex: number;
  chunkSize: number;
  chunkType: FileChunk['chunkType'];
  contentHash: string;
  createdAt: string;
  embeddingDimensions?: number;
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  fileRecordId: string;
  hasEmbedding?: boolean;
  id: string;
  tokenCount: number;
  updatedAt: string;
}

export interface DatabaseCollectionCounts {
  chunks: number;
  embeddings: number;
  records: number;
}

export type DatabaseCollectionCountsStatus = 'pending' | 'ready';

export interface DatabaseRecordPagination {
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalRecords: number;
}

export interface UseDatabaseDemoDataResult extends DatabaseLoaders {
  chunks: DatabaseFileChunkSummary[];
  collectionCounts: DatabaseCollectionCounts;
  collectionCountsStatus: DatabaseCollectionCountsStatus;
  dbInfo: DatabaseInfo | null;
  recordPagination: DatabaseRecordPagination;
  records: DatabaseFileRecordSummary[];
  refreshing: boolean;
  setDbInfo: (info: DatabaseInfo | null) => void;
}

const DEFAULT_DB_INFO: DatabaseInfo = {
  location: 'Unknown',
  testResult: 'Database connection not tested',
  connected: false,
};

const EXPORT_LOAD_BATCH_SIZE = 50;
const LARGE_DATABASE_PAGE_DIAGNOSTIC_RECORD_THRESHOLD = 250;
const LARGE_DATABASE_PAGE_DIAGNOSTIC_CHUNK_THRESHOLD = 1000;
const LARGE_DATABASE_PAGE_DIAGNOSTIC_TOTAL_THRESHOLD = 1000;

async function mapInBatches<T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
  batchSize = EXPORT_LOAD_BATCH_SIZE
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await Promise.all(batch.map((item) => mapper(item)));
    results.push(...batchResults);
  }
  return results;
}

// PERFORMANCE: Do NOT select the full embedding column in live queries!
// See FILE_CHUNKS_LIVE_QUERY comment for details.
const FILE_RECORDS_PAGE_QUERY = `
  WITH page_records AS (
    SELECT
      fr.id,
      fr.name,
      fr.path,
      fr.size,
      fr.created_at,
      fr.updated_at,
      fr.content_hash,
      fr.token_count,
      fr.processed_at,
      fr.chunks_processed_at,
      fr.chunks_count,
      fr.chunking_strategy,
      fr.embedding_set_id
    FROM file_records fr
    WHERE fr.embedding_set_id = $1
    ORDER BY fr.updated_at DESC, fr.id DESC
    LIMIT $2
    OFFSET $3
  ),
  embedded_chunk_counts AS (
    SELECT
      file_record_id,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded_chunk_count
    FROM file_chunks
    WHERE embedding_set_id = $4
      AND file_record_id IN (SELECT id FROM page_records)
    GROUP BY file_record_id
  )
  SELECT
    pr.id,
    pr.name,
    pr.path,
    pr.size,
    pr.created_at AS "createdAt",
    pr.updated_at AS "updatedAt",
    pr.content_hash AS "contentHash",
    pr.token_count AS "tokenCount",
    pr.processed_at AS "processedAt",
    pr.chunks_processed_at AS "chunksProcessedAt",
    pr.chunks_count AS "chunksCount",
    COALESCE(ecc.embedded_chunk_count, 0) AS "embeddedChunksCount",
    pr.chunking_strategy AS "chunkingStrategy",
    (COALESCE(ecc.embedded_chunk_count, 0) > 0) AS "hasEmbedding",
    pr.embedding_set_id AS "embeddingSetId"
  FROM page_records pr
  LEFT JOIN embedded_chunk_counts ecc ON ecc.file_record_id = pr.id
  ORDER BY pr.updated_at DESC, pr.id DESC
`.trim();

const FILE_RECORDS_TOTAL_QUERY = `
  WITH target AS (SELECT $1::text AS embedding_set_id)
  SELECT
    target.embedding_set_id AS "embeddingSetId",
    COUNT(fr.id)::int AS "totalRecords"
  FROM target
  LEFT JOIN file_records fr ON fr.embedding_set_id = target.embedding_set_id
  GROUP BY target.embedding_set_id
`.trim();

// Active-collection counts are computed live from file_records/file_chunks via
// ACTIVE_COLLECTION_LIVE_COUNTS_QUERY (owned by @brainstrike/db). The denormalized
// collection_indexing_stats table is dirty-gated and only refreshed periodically,
// so it reads stale zeroes for the collection being actively indexed — the live
// query keeps the visible counts ticking up through import/chunk/embed.
const COLLECTION_COUNTS_QUERY = ACTIVE_COLLECTION_LIVE_COUNTS_QUERY;

// PERFORMANCE: chunk summaries for the collection browser are loaded per file on demand.
// The visible renderer must not materialize every chunk row in the active collection just to
// render a paginated tree. This query is intentionally scoped to a single file record.
const FILE_CHUNKS_FOR_FILE_RECORD_QUERY = `
  SELECT
    id,
    file_record_id AS "fileRecordId",
    chunk_index AS "chunkIndex",
    content_hash AS "contentHash",
    token_count AS "tokenCount",
    chunk_type AS "chunkType",
    chunk_size AS "chunkSize",
    (embedding IS NOT NULL) AS "hasEmbedding",
    COALESCE(vector_dims(embedding), 0) AS "embeddingDimensions",
    embedding_set_id AS "embeddingSetId",
    embedding_updated_at AS "embeddingUpdatedAt",
    embedding_hash AS "embeddingHash",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM file_chunks
  WHERE file_record_id = $1
  ORDER BY chunk_index ASC
`.trim();

export function useDatabaseDemoData({
  repository,
  chunkRepository: _chunkRepository,
  toast,
  database,
  activeCollectionId,
  isEmbeddingActive = false,
  isImporting = false,
  recordPage = 0,
  recordPageSize = 50,
  supportsPGliteCollectionQueries = true,
  databaseRuntimeEngine = null,
}: UseDatabaseDemoDataOptions): UseDatabaseDemoDataResult {
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);
  const manualRefreshCountRef = useRef(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const cachedRecordsRef = useRef<Map<string, DatabaseFileRecordSummary[]>>(new Map());
  const cachedRecordTotalsRef = useRef<Map<string, number>>(new Map());
  const cachedCollectionCountsRef = useRef<Map<string, DatabaseCollectionCounts>>(new Map());
  const cachedLoadedChunksRef = useRef<Map<string, Map<string, DatabaseFileChunkSummary[]>>>(
    new Map()
  );
  const loadedRecordPagesRef = useRef<Set<string>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackError, setFallbackError] = useState<Error | null>(null);

  // Global schema verification cache - persists across component remounts
  const globalSchemaVerified = useVectorStatusUIStore((s) => s.schemaVerified);
  // Global file data cache - persists across component remounts during imports
  const globalCachedFileData = useVectorStatusUIStore((s) => s.cachedFileData);
  const setGlobalCachedFileData = useVectorStatusUIStore((s) => s.setCachedFileData);

  void _chunkRepository;

  const normalizedRecordPage = Number.isFinite(recordPage)
    ? Math.max(0, Math.trunc(recordPage))
    : 0;
  const normalizedRecordPageSize =
    Number.isFinite(recordPageSize) && recordPageSize > 0 ? Math.trunc(recordPageSize) : 50;
  const recordOffset = normalizedRecordPage * normalizedRecordPageSize;
  const recordPageCacheKey = activeCollectionId
    ? buildRecordPageCacheKey(activeCollectionId, normalizedRecordPage, normalizedRecordPageSize)
    : null;

  useEffect(() => {
    if (!database) {
      setSchemaReady(false);
      return;
    }
    setSchemaReady(globalSchemaVerified);
  }, [database, globalSchemaVerified]);

  // Restore cached data from global store on mount
  useEffect(() => {
    if (!globalCachedFileData || activeCollectionId !== globalCachedFileData.collectionId) {
      return;
    }
    if (
      globalCachedFileData.page !== normalizedRecordPage ||
      globalCachedFileData.pageSize !== normalizedRecordPageSize
    ) {
      return;
    }
    if (!recordPageCacheKey) {
      return;
    }

    let didRestoreFromGlobalCache = false;

    if (!loadedRecordPagesRef.current.has(recordPageCacheKey)) {
      cachedRecordsRef.current.set(
        recordPageCacheKey,
        globalCachedFileData.records.map(restoreCachedRecord)
      );
      cachedRecordTotalsRef.current.set(activeCollectionId, globalCachedFileData.totalRecords);
      cachedCollectionCountsRef.current.set(
        activeCollectionId,
        globalCachedFileData.collectionCounts
      );
      loadedRecordPagesRef.current.add(recordPageCacheKey);
      didRestoreFromGlobalCache = true;
    }

    if (!cachedLoadedChunksRef.current.has(recordPageCacheKey)) {
      cachedLoadedChunksRef.current.set(
        recordPageCacheKey,
        restoreCachedChunkGroups(globalCachedFileData.chunks)
      );
      didRestoreFromGlobalCache =
        didRestoreFromGlobalCache || globalCachedFileData.chunks.length > 0;
    }

    if (didRestoreFromGlobalCache) {
      setCacheVersion((prev) => prev + 1);
    }
  }, [
    activeCollectionId,
    globalCachedFileData,
    normalizedRecordPage,
    normalizedRecordPageSize,
    recordPageCacheKey,
  ]);

  useEffect(() => {
    if (!database) {
      return;
    }
    if (globalSchemaVerified) {
      setFallbackError(null);
    }
  }, [database, globalSchemaVerified]);

  const recordErrorRef = useRef<string | null>(null);
  const fallbackErrorRef = useRef<string | null>(null);

  const runManualRefresh = useCallback(async (task: () => Promise<void>) => {
    manualRefreshCountRef.current += 1;
    setManualRefreshing(true);
    try {
      await task();
    } finally {
      manualRefreshCountRef.current -= 1;
      if (manualRefreshCountRef.current <= 0) {
        manualRefreshCountRef.current = 0;
        setManualRefreshing(false);
      }
    }
  }, []);

  const recordQueryParams = useMemo<readonly [string, number, number, string] | undefined>(
    () =>
      activeCollectionId
        ? [activeCollectionId, normalizedRecordPageSize, recordOffset, activeCollectionId]
        : undefined,
    [activeCollectionId, normalizedRecordPageSize, recordOffset]
  );
  const recordTotalQueryParams = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? [activeCollectionId] : undefined),
    [activeCollectionId]
  );
  const collectionCountsQueryParams = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? [activeCollectionId] : undefined),
    [activeCollectionId]
  );

  // Pause live queries only during the foreground import path. Background embedding keeps
  // collection pages and counts live, but the queries above are intentionally page-scoped
  // and single-scan so embedding updates do not rematerialize the full collection page.
  const liveQueryEnabled = Boolean(
    supportsPGliteCollectionQueries && database && schemaReady && activeCollectionId && !isImporting
  );

  const {
    rows: recordRows,
    loading: recordsLoading,
    error: recordsError,
    refresh: refreshRecordsQuery,
  } = useBrainstrikeLiveQuery<FileRecordRow>({
    cacheKey: makeLiveQueryKey(
      'file-records',
      activeCollectionId,
      normalizedRecordPage,
      normalizedRecordPageSize
    ),
    query: FILE_RECORDS_PAGE_QUERY,
    ...(recordQueryParams ? { params: recordQueryParams } : {}),
    mode: 'incremental',
    key: 'id',
    enabled: liveQueryEnabled,
    clearOnDisable: true,
  });
  const {
    rows: totalRecordRows,
    loading: totalRecordsLoading,
    refresh: refreshTotalRecordsQuery,
  } = useBrainstrikeLiveQuery<FileRecordsTotalRow>({
    cacheKey: makeLiveQueryKey('file-records-total', activeCollectionId),
    query: FILE_RECORDS_TOTAL_QUERY,
    ...(recordTotalQueryParams ? { params: recordTotalQueryParams } : {}),
    enabled: liveQueryEnabled,
  });
  const {
    rows: collectionCountRows,
    loading: collectionCountsLoading,
    refresh: refreshCollectionCountsQuery,
  } = useBrainstrikeLiveQuery<CollectionCountsRow>({
    cacheKey: makeLiveQueryKey('file-record-collection-counts', activeCollectionId),
    query: COLLECTION_COUNTS_QUERY,
    ...(collectionCountsQueryParams ? { params: collectionCountsQueryParams } : {}),
    // Single-row aggregate: use a plain (full) live query like the records total
    // rather than an incremental keyed diff.
    enabled: liveQueryEnabled,
  });

  const records = useMemo<DatabaseFileRecordSummary[]>(() => {
    if (!(schemaReady && activeCollectionId)) {
      return [];
    }
    return recordRows.map(mapRecordRow);
  }, [recordRows, schemaReady, activeCollectionId]);
  const liveRecordsMatchActiveCollection = useMemo(
    () => Boolean(activeCollectionId && recordsBelongToCollection(records, activeCollectionId)),
    [activeCollectionId, records]
  );
  const liveTotalRecords = useMemo(() => {
    const firstRow = totalRecordRows[0];
    if (!(activeCollectionId && rowBelongsToCollection(firstRow, activeCollectionId))) {
      return null;
    }
    return normalizeCount(firstRow?.totalRecords);
  }, [activeCollectionId, totalRecordRows]);
  const liveTotalRecordsReady = liveTotalRecords !== null;
  const liveCollectionCounts = useMemo<DatabaseCollectionCounts>(() => {
    const firstRow = collectionCountRows[0];
    if (
      !(
        activeCollectionId &&
        firstRow &&
        collectionCountsRowBelongsToCollection(firstRow, activeCollectionId)
      )
    ) {
      return { records: 0, chunks: 0, embeddings: 0 };
    }
    return mapCollectionCountsRow(firstRow);
  }, [activeCollectionId, collectionCountRows]);
  const liveCollectionCountsStatus: DatabaseCollectionCountsStatus = useMemo(() => {
    if (collectionCountsLoading) {
      return 'pending';
    }
    const firstRow = collectionCountRows[0];
    if (!(activeCollectionId && firstRow)) {
      return 'pending';
    }
    return collectionCountsRowBelongsToCollection(firstRow, activeCollectionId)
      ? 'ready'
      : 'pending';
  }, [activeCollectionId, collectionCountRows, collectionCountsLoading]);

  const refreshCollectionCountsInBackground = useCallback(() => {
    void refreshCollectionCountsQuery().catch((error: unknown) => {
      logger.warn('Failed to refresh collection counts', { error });
    });
  }, [refreshCollectionCountsQuery]);

  // biome-ignore lint/plugin: This syncs live query results to cache, not fetching data
  useEffect(() => {
    if (
      !(liveQueryEnabled && activeCollectionId && recordPageCacheKey) ||
      recordsLoading ||
      totalRecordsLoading ||
      collectionCountsLoading ||
      !liveRecordsMatchActiveCollection ||
      !liveTotalRecordsReady ||
      liveCollectionCountsStatus !== 'ready'
    ) {
      return;
    }
    cachedRecordsRef.current.set(recordPageCacheKey, records);
    cachedRecordTotalsRef.current.set(activeCollectionId, liveTotalRecords);
    cachedCollectionCountsRef.current.set(activeCollectionId, liveCollectionCounts);
    loadedRecordPagesRef.current.add(recordPageCacheKey);
    setCacheVersion((prev) => prev + 1);
    setFallbackError(null);
    const cachedChunksForCollection = Array.from(
      cachedLoadedChunksRef.current.get(recordPageCacheKey)?.values() ?? []
    ).flat();
    setGlobalCachedFileData(
      buildCollectionFileDataSnapshot(
        activeCollectionId,
        normalizedRecordPage,
        normalizedRecordPageSize,
        liveTotalRecords,
        liveCollectionCounts,
        records,
        cachedChunksForCollection
      )
    );
  }, [
    activeCollectionId,
    liveCollectionCounts,
    liveCollectionCountsStatus,
    liveRecordsMatchActiveCollection,
    liveQueryEnabled,
    liveTotalRecords,
    liveTotalRecordsReady,
    normalizedRecordPage,
    normalizedRecordPageSize,
    recordPageCacheKey,
    records,
    totalRecordsLoading,
    collectionCountsLoading,
    recordsLoading,
    setGlobalCachedFileData,
  ]);

  const cachedRecords = useMemo<DatabaseFileRecordSummary[]>(() => {
    if (!(schemaReady && recordPageCacheKey)) {
      return [];
    }
    return cachedRecordsRef.current.get(recordPageCacheKey) ?? [];
  }, [cacheVersion, recordPageCacheKey, schemaReady]);
  const cachedTotalRecords = useMemo(() => {
    if (!activeCollectionId) {
      return 0;
    }
    return cachedRecordTotalsRef.current.get(activeCollectionId) ?? 0;
  }, [activeCollectionId, cacheVersion]);
  const cachedCollectionCounts = useMemo<DatabaseCollectionCounts>(() => {
    if (!activeCollectionId) {
      return { records: 0, chunks: 0, embeddings: 0 };
    }
    return (
      cachedCollectionCountsRef.current.get(activeCollectionId) ?? {
        records: 0,
        chunks: 0,
        embeddings: 0,
      }
    );
  }, [activeCollectionId, cacheVersion]);

  const cachedChunks = useMemo<DatabaseFileChunkSummary[]>(() => {
    if (!(schemaReady && recordPageCacheKey)) {
      return [];
    }
    return Array.from(cachedLoadedChunksRef.current.get(recordPageCacheKey)?.values() ?? []).flat();
  }, [cacheVersion, recordPageCacheKey, schemaReady]);

  const fetchSnapshot = useCallback(
    async (options: {
      includeCollectionCounts: boolean;
      includeRecords: boolean;
      includeTotalRecords: boolean;
    }) => {
      if (
        !(
          supportsPGliteCollectionQueries &&
          database &&
          schemaReady &&
          activeCollectionId &&
          recordPageCacheKey
        )
      ) {
        return;
      }
      if (typeof (database as { query?: unknown }).query !== 'function') {
        return;
      }
      const queryDatabase = database as {
        query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
      };
      const recordParams = recordQueryParams ?? [
        activeCollectionId,
        normalizedRecordPageSize,
        recordOffset,
        activeCollectionId,
      ];
      const recordsResult = await (options.includeRecords
        ? queryDatabase.query<FileRecordRow>(FILE_RECORDS_PAGE_QUERY, recordParams)
        : Promise.resolve(null));
      const totalRecordsResult = await (options.includeTotalRecords
        ? queryDatabase.query<FileRecordsTotalRow>(FILE_RECORDS_TOTAL_QUERY, [activeCollectionId])
        : Promise.resolve(null));
      const collectionCountsResult = await (options.includeCollectionCounts
        ? queryDatabase.query<CollectionCountsRow>(COLLECTION_COUNTS_QUERY, [activeCollectionId])
        : Promise.resolve(null));

      if (recordsResult) {
        cachedRecordsRef.current.set(recordPageCacheKey, recordsResult.rows.map(mapRecordRow));
        loadedRecordPagesRef.current.add(recordPageCacheKey);
      }
      if (totalRecordsResult) {
        cacheTotalRecordsForCollection({
          cache: cachedRecordTotalsRef.current,
          collectionId: activeCollectionId,
          rows: totalRecordsResult.rows,
        });
      }
      if (collectionCountsResult) {
        cacheCollectionCountsForCollection({
          cache: cachedCollectionCountsRef.current,
          collectionId: activeCollectionId,
          rows: collectionCountsResult.rows,
        });
      }

      setCacheVersion((prev) => prev + 1);
    },
    [
      activeCollectionId,
      database,
      normalizedRecordPageSize,
      recordOffset,
      recordPageCacheKey,
      recordQueryParams,
      schemaReady,
      supportsPGliteCollectionQueries,
    ]
  );

  // biome-ignore lint/plugin: Fallback snapshot hydration is an intentional effect when live queries are paused.
  useEffect(() => {
    if (liveQueryEnabled) {
      return;
    }
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }
    if (!supportsPGliteCollectionQueries) {
      return;
    }
    if (fallbackLoading) {
      return;
    }
    const needsRecords = recordPageCacheKey
      ? !loadedRecordPagesRef.current.has(recordPageCacheKey)
      : false;
    const needsTotalRecords = cachedRecordTotalsRef.current.get(activeCollectionId) === undefined;
    const needsCollectionCounts =
      cachedCollectionCountsRef.current.get(activeCollectionId) === undefined;
    if (!(needsRecords || needsTotalRecords || needsCollectionCounts)) {
      return;
    }

    let cancelled = false;
    setFallbackLoading(true);
    setFallbackError(null);

    const runFallback = async () => {
      try {
        await fetchSnapshot({
          includeRecords: needsRecords,
          includeTotalRecords: needsTotalRecords,
          includeCollectionCounts: needsCollectionCounts,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        logger.error('Failed to load database demo snapshot', { error: normalized });
        setFallbackError(normalized);
      } finally {
        if (!cancelled) {
          setFallbackLoading(false);
        }
      }
    };

    void runFallback();

    return () => {
      cancelled = true;
    };
  }, [
    activeCollectionId,
    database,
    fallbackLoading,
    fetchSnapshot,
    liveQueryEnabled,
    recordPageCacheKey,
    schemaReady,
    supportsPGliteCollectionQueries,
  ]);

  const resolvedRecords =
    liveQueryEnabled && !recordsLoading && liveRecordsMatchActiveCollection
      ? records
      : cachedRecords;
  const resolvedTotalRecords =
    liveQueryEnabled && !totalRecordsLoading && liveTotalRecordsReady
      ? liveTotalRecords
      : cachedTotalRecords;
  const resolvedCollectionCounts =
    liveQueryEnabled && !collectionCountsLoading && liveCollectionCountsStatus === 'ready'
      ? liveCollectionCounts
      : cachedCollectionCounts;
  const resolvedCollectionCountsStatus: DatabaseCollectionCountsStatus =
    liveQueryEnabled && liveCollectionCountsStatus === 'ready' ? 'ready' : 'pending';
  const pageDataDiagnosticSignatureRef = useRef<string | null>(null);

  const loadFileChunkSummaries = useCallback(
    async (fileRecordId: string): Promise<DatabaseFileChunkSummary[]> => {
      if (!fileRecordId) {
        throw new Error('Chunk summary requests require a file record id.');
      }
      if (!activeCollectionId) {
        throw new Error('Chunk summary requests require an active collection.');
      }
      if (!recordPageCacheKey) {
        throw new Error('Chunk summary requests require an active collection page.');
      }
      if (!(database && schemaReady)) {
        throw new Error('Chunk summary requests require an initialized database.');
      }
      if (!supportsPGliteCollectionQueries) {
        throw new Error('Chunk summary requests require PGlite-compatible collection queries.');
      }
      if (typeof (database as { query?: unknown }).query !== 'function') {
        throw new Error('Chunk summary requests require database query support.');
      }

      const result = await (
        database as {
          query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
        }
      ).query<FileChunkRow>(FILE_CHUNKS_FOR_FILE_RECORD_QUERY, [fileRecordId]);

      const summaries = result.rows.map(mapChunkRow);
      const collectionChunks =
        cachedLoadedChunksRef.current.get(recordPageCacheKey) ??
        new Map<string, DatabaseFileChunkSummary[]>();
      collectionChunks.set(fileRecordId, summaries);
      cachedLoadedChunksRef.current.set(recordPageCacheKey, collectionChunks);
      setCacheVersion((prev) => prev + 1);

      const cachedRecordsForCollection = cachedRecordsRef.current.get(recordPageCacheKey) ?? [];
      const cachedChunksForCollection = Array.from(collectionChunks.values()).flat();
      setGlobalCachedFileData(
        buildCollectionFileDataSnapshot(
          activeCollectionId,
          normalizedRecordPage,
          normalizedRecordPageSize,
          cachedRecordTotalsRef.current.get(activeCollectionId) ?? 0,
          cachedCollectionCountsRef.current.get(activeCollectionId) ?? {
            records: 0,
            chunks: 0,
            embeddings: 0,
          },
          cachedRecordsForCollection,
          cachedChunksForCollection
        )
      );

      return summaries;
    },
    [
      activeCollectionId,
      database,
      normalizedRecordPage,
      normalizedRecordPageSize,
      recordPageCacheKey,
      schemaReady,
      setGlobalCachedFileData,
      supportsPGliteCollectionQueries,
    ]
  );

  const loadRecords = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }
    if (!supportsPGliteCollectionQueries) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        if (liveQueryEnabled) {
          refreshCollectionCountsInBackground();
          await Promise.all([refreshRecordsQuery(), refreshTotalRecordsQuery()]);
        } else {
          await fetchSnapshot({
            includeRecords: true,
            includeTotalRecords: true,
            includeCollectionCounts: true,
          });
        }
      } catch (error) {
        logger.error('Failed to refresh database records', { error });
        const message = extractErrorMessage(error);
        toast({
          title: 'Error',
          description:
            message && isMissingRelation(message, 'file_records')
              ? 'File storage is missing or needs migration. Run Factory Reset to rebuild the database.'
              : 'Failed to refresh file list',
          variant: 'destructive',
        });
      }
    });
  }, [
    activeCollectionId,
    fetchSnapshot,
    database,
    liveQueryEnabled,
    refreshCollectionCountsInBackground,
    refreshRecordsQuery,
    refreshTotalRecordsQuery,
    runManualRefresh,
    schemaReady,
    supportsPGliteCollectionQueries,
    toast,
  ]);

  const loadChunks = useCallback(async () => {
    if (!recordPageCacheKey) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        const loadedChunksByFile = cachedLoadedChunksRef.current.get(recordPageCacheKey);
        if (!loadedChunksByFile || loadedChunksByFile.size === 0) {
          return;
        }
        await Promise.all(
          Array.from(loadedChunksByFile.keys()).map((fileRecordId) =>
            loadFileChunkSummaries(fileRecordId)
          )
        );
      } catch (error) {
        logger.error('Failed to refresh database chunks', { error });
        toast({
          title: 'Error',
          description: 'Failed to refresh loaded chunk summaries',
          variant: 'destructive',
        });
      }
    });
  }, [loadFileChunkSummaries, recordPageCacheKey, runManualRefresh, toast]);

  const loadChunkDetail = useCallback(
    async (chunkId: string): Promise<FileChunk | null> => {
      if (!chunkId) {
        throw new Error('Chunk detail requests require a chunk id.');
      }
      if (!_chunkRepository) {
        throw new Error('Chunk detail repository is unavailable.');
      }
      if (!('findById' in _chunkRepository) || typeof _chunkRepository.findById !== 'function') {
        throw new Error('Chunk detail repository does not support findById.');
      }
      return _chunkRepository.findById(chunkId);
    },
    [_chunkRepository]
  );

  const loadCollectionExportData = useCallback(async (): Promise<{
    chunks: FileChunk[];
    records: FileRecord[];
  }> => {
    if (!activeCollectionId) {
      throw new Error('Export requests require an active collection.');
    }
    if (!repository) {
      throw new Error('File export repository is unavailable.');
    }
    if (!(database && typeof (database as { query?: unknown }).query === 'function')) {
      throw new Error('Collection export requires database query support.');
    }
    if (!supportsPGliteCollectionQueries) {
      throw new Error('Collection export requires PGlite-compatible collection queries.');
    }
    if (!_chunkRepository) {
      throw new Error('Chunk export repository is unavailable.');
    }
    if (!('findById' in repository) || typeof repository.findById !== 'function') {
      throw new Error('File export repository does not support findById.');
    }
    if (
      !('findByFileRecordId' in _chunkRepository) ||
      typeof _chunkRepository.findByFileRecordId !== 'function'
    ) {
      throw new Error('Chunk export repository does not support findByFileRecordId.');
    }
    const findChunksByFileRecordId = _chunkRepository.findByFileRecordId;

    const recordIdsResult = await (
      database as {
        query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
      }
    ).query<{ id: string }>(
      `
        SELECT id
        FROM file_records
        WHERE embedding_set_id = $1
        ORDER BY updated_at DESC, id DESC
      `,
      [activeCollectionId]
    );
    const recordIds = recordIdsResult.rows.map((record) => record.id);
    const settledRecords = await mapInBatches(recordIds, async (recordId) => {
      const record = await repository.findById(recordId);
      if (!record) {
        throw new Error(`Missing file record during export: ${recordId}`);
      }
      return record;
    });

    const chunkGroups = await mapInBatches(settledRecords, (record) =>
      findChunksByFileRecordId(record.id)
    );

    return {
      records: settledRecords,
      chunks: chunkGroups.flat(),
    };
  }, [_chunkRepository, activeCollectionId, database, repository, supportsPGliteCollectionQueries]);

  const refreshVisibleData = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }
    if (!supportsPGliteCollectionQueries) {
      return;
    }

    await runManualRefresh(async () => {
      if (liveQueryEnabled) {
        refreshCollectionCountsInBackground();
        await Promise.all([refreshRecordsQuery(), refreshTotalRecordsQuery()]);
        return;
      }
      await fetchSnapshot({
        includeRecords: true,
        includeTotalRecords: true,
        includeCollectionCounts: true,
      });
    });
  }, [
    activeCollectionId,
    database,
    fetchSnapshot,
    liveQueryEnabled,
    refreshCollectionCountsInBackground,
    refreshRecordsQuery,
    refreshTotalRecordsQuery,
    runManualRefresh,
    schemaReady,
    supportsPGliteCollectionQueries,
  ]);

  const previousLiveQueryEnabledRef = useRef(liveQueryEnabled);

  useEffect(() => {
    if (!activeCollectionId) {
      pageDataDiagnosticSignatureRef.current = null;
      return;
    }

    const loadedChunkGroups = countLoadedChunkGroups(cachedLoadedChunksRef.current);
    const totalLoadedChunks = countLoadedChunks(cachedLoadedChunksRef.current);
    const shouldLog =
      resolvedRecords.length >= LARGE_DATABASE_PAGE_DIAGNOSTIC_RECORD_THRESHOLD ||
      cachedChunks.length >= LARGE_DATABASE_PAGE_DIAGNOSTIC_CHUNK_THRESHOLD ||
      resolvedTotalRecords >= LARGE_DATABASE_PAGE_DIAGNOSTIC_TOTAL_THRESHOLD ||
      resolvedCollectionCounts.chunks >= LARGE_DATABASE_PAGE_DIAGNOSTIC_TOTAL_THRESHOLD ||
      loadedChunkGroups >= LARGE_DATABASE_PAGE_DIAGNOSTIC_RECORD_THRESHOLD;
    if (!shouldLog) {
      pageDataDiagnosticSignatureRef.current = null;
      return;
    }

    const embeddingCountBucket = Math.floor(resolvedCollectionCounts.embeddings / 100);
    const diagnosticSignature = [
      activeCollectionId,
      liveQueryEnabled ? 'live' : 'snapshot',
      normalizedRecordPage,
      normalizedRecordPageSize,
      resolvedRecords.length,
      cachedChunks.length,
      resolvedTotalRecords,
      resolvedCollectionCounts.records,
      resolvedCollectionCounts.chunks,
      embeddingCountBucket,
      loadedRecordPagesRef.current.size,
      loadedChunkGroups,
      totalLoadedChunks,
      fallbackLoading ? 'loading' : 'idle',
      manualRefreshing ? 'refreshing' : 'steady',
    ].join('|');
    if (pageDataDiagnosticSignatureRef.current === diagnosticSignature) {
      return;
    }
    pageDataDiagnosticSignatureRef.current = diagnosticSignature;

    logger.info('Large database page state resolved', {
      activeCollectionId,
      dataSource: liveQueryEnabled ? 'live-query' : 'snapshot-cache',
      page: normalizedRecordPage,
      pageSize: normalizedRecordPageSize,
      resolvedRecordCount: resolvedRecords.length,
      cachedChunkCount: cachedChunks.length,
      resolvedTotalRecords,
      collectionRecordCount: resolvedCollectionCounts.records,
      collectionChunkCount: resolvedCollectionCounts.chunks,
      collectionEmbeddingCount: resolvedCollectionCounts.embeddings,
      loadedRecordPageCount: loadedRecordPagesRef.current.size,
      loadedChunkGroupCount: loadedChunkGroups,
      loadedChunkCount: totalLoadedChunks,
      recordCachePageCount: cachedRecordsRef.current.size,
      totalCacheEntryCount: cachedRecordTotalsRef.current.size,
      collectionCountCacheEntryCount: cachedCollectionCountsRef.current.size,
      chunkPageCacheEntryCount: cachedLoadedChunksRef.current.size,
      fallbackLoading,
      manualRefreshing,
      isImporting,
      isEmbeddingActive,
    });
  }, [
    activeCollectionId,
    cachedChunks.length,
    fallbackLoading,
    isEmbeddingActive,
    isImporting,
    liveQueryEnabled,
    manualRefreshing,
    normalizedRecordPage,
    normalizedRecordPageSize,
    resolvedCollectionCounts,
    resolvedRecords.length,
    resolvedTotalRecords,
  ]);

  useEffect(() => {
    const wasEnabled = previousLiveQueryEnabledRef.current;
    previousLiveQueryEnabledRef.current = liveQueryEnabled;
    if (!(liveQueryEnabled && !wasEnabled)) {
      return;
    }
    void refreshVisibleData();
  }, [liveQueryEnabled, refreshVisibleData]);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeCollectionId) {
      return;
    }

    const handleQueueDrained = (event: Event) => {
      const detail = (event as CustomEvent<{ embeddingSetId?: string | null } | undefined>).detail;
      if (detail?.embeddingSetId && detail.embeddingSetId !== activeCollectionId) {
        return;
      }
      void refreshVisibleData();
    };

    window.addEventListener('brainstrike:queue-drained', handleQueueDrained);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handleQueueDrained);
    };
  }, [activeCollectionId, refreshVisibleData]);

  useEffect(() => {
    if (!recordsError) {
      recordErrorRef.current = null;
      return;
    }
    const message = extractErrorMessage(recordsError) ?? 'Failed to load files';
    if (recordErrorRef.current === message) {
      return;
    }
    recordErrorRef.current = message;
    toast({
      title: 'Error',
      description: message,
      variant: 'destructive',
    });
  }, [recordsError, toast]);

  useEffect(() => {
    if (!fallbackError) {
      fallbackErrorRef.current = null;
      return;
    }
    const message = extractErrorMessage(fallbackError) ?? 'Failed to load database snapshot';
    if (fallbackErrorRef.current === message) {
      return;
    }
    fallbackErrorRef.current = message;
    toast({
      title: 'Error',
      description: message,
      variant: 'destructive',
    });
  }, [fallbackError, toast]);

  const testDatabaseConnection = useCallback(async () => {
    const location = resolveStorageLocation(repository, databaseRuntimeEngine);
    if (!repository) {
      setDbInfo({
        location,
        testResult: 'Repository not available',
        connected: false,
      });
      return;
    }

    try {
      if (typeof repository.count !== 'function') {
        throw new Error('File record repository does not support count().');
      }
      const count = await repository.count();
      setDbInfo({
        location,
        testResult: `Successfully connected - ${count} file records found`,
        connected: true,
      });
    } catch (error) {
      setDbInfo({
        location,
        testResult: `Database connection failed: ${error}`,
        connected: false,
      });
    }
  }, [databaseRuntimeEngine, repository]);

  const databasePingHandlers = useMemo(() => {
    const handlers: Array<() => Promise<void>> = [];
    if (typeof window === 'undefined') {
      return handlers;
    }
    const location = databaseRuntimeEngine === 'turso' ? 'Turso' : 'Main Process';
    const w = window as unknown as {
      electronAPI?: {
        db?: {
          ping?: () => Promise<{ success?: boolean }>;
          test?: () => Promise<{ success?: boolean }>;
        };
      };
    };

    if (w?.electronAPI?.db?.ping) {
      handlers.push(async () => {
        try {
          const res = await w.electronAPI?.db?.ping?.();
          if (res?.success) {
            setDbInfo({
              location,
              testResult: 'connected',
              connected: true,
            });
          }
        } catch (error) {
          logger.debug('Electron DB ping failed', { error });
          // allow repository-based test to set state
        }
      });
    }

    if (w?.electronAPI?.db?.test) {
      handlers.push(async () => {
        try {
          const res = await w.electronAPI?.db?.test?.();
          if (res?.success) {
            setDbInfo({
              location,
              testResult: 'Connected (IPC)',
              connected: true,
            });
          }
        } catch (error) {
          logger.debug('Electron DB test handler failed', { error });
          // fall back to repository-based test
        }
      });
    }

    return handlers;
  }, [databaseRuntimeEngine]);

  useEffect(() => {
    if (!repository) {
      setDbInfo(DEFAULT_DB_INFO);
      return;
    }

    void testDatabaseConnection();
  }, [repository, testDatabaseConnection]);

  // biome-ignore lint/plugin: Run registered ping handlers - callback invocation pattern with cleanup
  useEffect(() => {
    if (databasePingHandlers.length === 0) {
      return;
    }
    let canceled = false;
    const runHandlers = async () => {
      for (const handler of databasePingHandlers) {
        if (canceled) {
          return;
        }
        await handler();
      }
    };
    void runHandlers();
    return () => {
      canceled = true;
    };
  }, [databasePingHandlers]);

  useEffect(() => {
    if (!database) {
      return;
    }
    if (databaseRuntimeEngine === 'turso') {
      return;
    }
    let canceled = false;
    const fetchInfo = async () => {
      try {
        const result = await database.query<{ location: string }>(
          'SELECT \'PGlite WASM\' AS "location"'
        );
        const firstRow = result?.rows?.[0];
        if (!canceled && firstRow?.location) {
          setDbInfo((prev) =>
            prev?.connected
              ? prev
              : {
                  location: firstRow.location,
                  testResult: prev?.testResult ?? 'connected',
                  connected: prev?.connected ?? true,
                }
          );
        }
      } catch (error) {
        logger.debug('Database info query failed', { error });
      }
    };
    void fetchInfo();
    return () => {
      canceled = true;
    };
  }, [database, databaseRuntimeEngine]);

  const refreshing = manualRefreshing || recordsLoading || totalRecordsLoading || fallbackLoading;

  // Sync local dbInfo state to global store for status bar
  useEffect(() => {
    const store = useDatabaseStatusStore.getState();
    if (dbInfo === null) {
      store.setLoading();
    } else if (dbInfo.connected) {
      store.setConnected(dbInfo.location, dbInfo.testResult);
    } else {
      store.setDisconnected(dbInfo.location, dbInfo.testResult);
    }
  }, [dbInfo]);

  return {
    collectionCounts: resolvedCollectionCounts,
    collectionCountsStatus: resolvedCollectionCountsStatus,
    records: resolvedRecords,
    chunks: cachedChunks,
    refreshing,
    dbInfo,
    recordPagination: {
      currentPage: normalizedRecordPage,
      pageSize: normalizedRecordPageSize,
      totalRecords: resolvedTotalRecords,
      totalPages: Math.max(
        1,
        Math.ceil(resolvedTotalRecords / Math.max(1, normalizedRecordPageSize))
      ),
    },
    setDbInfo,
    loadChunkDetail,
    loadFileChunkSummaries,
    loadCollectionExportData,
    loadRecords,
    loadChunks,
  };
}
