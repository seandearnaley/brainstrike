import {
  type DrizzleFileChunkRepository,
  type DrizzleFileRecordRepository,
  type ElectronFileChunkRepository,
  type ElectronFileRecordRepository,
  type FileChunk,
  type FileRecord,
  makeLiveQueryKey,
  type usePGliteDatabase,
  usePGliteLiveQuery,
} from '@brainstrike/db';
import { useDatabaseStatusStore, useVectorStatusUIStore } from '@brainstrike/preferences';
import { isResolvedChunkingStrategy } from '@brainstrike/text-splitter';
import type { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('DatabaseDemoData');

/**
 * Resolve the storage location label based on the repository type.
 * This must match the expected values in database-status-item.tsx for proper status bar display.
 * - "Main Process" → displays as "IPC" in status bar
 * - "PGlite WASM" → displays as "PGlite WASM" in status bar
 */
function resolveStorageLocation(
  repository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null
): string {
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

export interface UseDatabaseDemoDataOptions {
  activeCollectionId: string | null;
  chunkRepository?: DrizzleFileChunkRepository | ElectronFileChunkRepository | null;
  database?: ReturnType<typeof usePGliteDatabase>;
  /** When true, live queries are paused and cache-backed snapshots are used. */
  isEmbeddingActive?: boolean;
  /** When true, live queries are paused to avoid performance degradation during bulk operations */
  isImporting?: boolean;
  repository: DrizzleFileRecordRepository | ElectronFileRecordRepository | null;
  toast: ReturnType<typeof useToast>['toast'];
}

interface DatabaseLoaders {
  loadChunks: () => Promise<void>;
  loadRecords: () => Promise<void>;
}

export interface UseDatabaseDemoDataResult extends DatabaseLoaders {
  chunks: FileChunk[];
  dbInfo: DatabaseInfo | null;
  records: FileRecord[];
  refreshing: boolean;
  setDbInfo: (info: DatabaseInfo | null) => void;
}

const DEFAULT_DB_INFO: DatabaseInfo = {
  location: 'Unknown',
  testResult: 'Database connection not tested',
  connected: false,
};

// PERFORMANCE: Do NOT select the full embedding column in live queries!
// See FILE_CHUNKS_LIVE_QUERY comment for details.
const FILE_RECORDS_LIVE_QUERY = `
  SELECT
    id,
    name,
    path,
    size,
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    content,
    content_hash AS "contentHash",
    token_count AS "tokenCount",
    processed_at AS "processedAt",
    chunks_processed_at AS "chunksProcessedAt",
    chunks_count AS "chunksCount",
    chunking_strategy AS "chunkingStrategy",
    (embedding IS NOT NULL) AS "hasEmbedding",
    embedding_set_id AS "embeddingSetId"
  FROM file_records
  WHERE embedding_set_id = $1
  ORDER BY updated_at DESC
`.trim();

// PERFORMANCE: Do NOT select the full embedding column in live queries!
// Embeddings are 384-768+ dimension float arrays - fetching them for every chunk
// causes massive slowdowns in browser WASM (PGlite). Instead, we compute:
// - hasEmbedding: boolean flag for UI status display
// - embeddingDimensions: length for metadata display (using vector_dims() for pgvector type)
// Full embeddings are only fetched on-demand during export operations.
const FILE_CHUNKS_LIVE_QUERY = `
  SELECT
    id,
    file_record_id AS "fileRecordId",
    chunk_index AS "chunkIndex",
    content,
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
  WHERE embedding_set_id = $1
  ORDER BY updated_at DESC
`.trim();

interface FileRecordRow {
  chunkingStrategy: string | null;
  chunksCount: number | null;
  chunksProcessedAt: string | null;
  content: string | null;
  contentHash: string | null;
  createdAt: string;
  embeddingSetId: string | null;
  /** Boolean flag - embedding exists but not fetched for performance */
  hasEmbedding: boolean;
  id: string;
  name: string;
  path: string;
  processedAt: string | null;
  size: number;
  tokenCount: number | null;
  updatedAt: string;
}

interface FileChunkRow {
  chunkIndex: number;
  chunkSize: number;
  chunkType: FileChunk['chunkType'];
  content: string;
  contentHash: string;
  createdAt: string;
  /** Embedding dimensions - computed from ARRAY_LENGTH for display without fetching full vector */
  embeddingDimensions: number;
  embeddingHash: string | null;
  embeddingSetId: string | null;
  embeddingUpdatedAt: string | null;
  fileRecordId: string;
  /** Boolean flag - embedding exists but not fetched for performance */
  hasEmbedding: boolean;
  id: string;
  tokenCount: number;
  updatedAt: string;
}

interface CachedRecordSummary {
  chunksCount: number | undefined;
  createdAt: string;
  embeddingSetId: string | undefined;
  id: string;
  name: string;
  path: string;
  size: number;
  tokenCount: number | undefined;
  updatedAt: string;
}

interface CachedChunkSummary {
  chunkIndex: number;
  chunkType: FileChunk['chunkType'];
  embeddingSetId: string | undefined;
  fileRecordId: string;
  id: string;
  tokenCount: number;
}

interface CollectionFileDataSnapshot {
  chunks: CachedChunkSummary[];
  collectionId: string;
  records: CachedRecordSummary[];
}

// NOTE: Embedding normalization functions (coerceNumericArray, parseStringEmbedding,
// normalizeEmbeddingVector) were removed as part of the performance optimization.
// Full embedding vectors are no longer fetched in live queries - only hasEmbedding
// and embeddingDimensions flags are used. If export functionality needs raw embeddings,
// a separate on-demand fetch should be implemented.

function mapRecordRow(row: FileRecordRow): FileRecord {
  const record: FileRecord = {
    id: row.id,
    name: row.name,
    path: row.path,
    size: row.size,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.content) {
    record.content = row.content;
  }
  if (row.contentHash) {
    record.contentHash = row.contentHash;
  }
  if (row.tokenCount !== null) {
    record.tokenCount = Number(row.tokenCount);
  }
  if (row.processedAt) {
    record.processedAt = row.processedAt;
  }
  // PERFORMANCE: We don't fetch full embedding vectors in live queries.
  // hasEmbedding is a boolean flag from the DB, used for UI status display.
  // NOTE: Export operations that need actual embedding values must fetch them separately.
  if (row.hasEmbedding) {
    // Set a placeholder array to indicate embedding exists (for backward compat with UI checks)
    record.embedding = [] as number[];
  }
  if (row.embeddingSetId) {
    record.embeddingSetId = row.embeddingSetId;
  }
  if (row.chunksProcessedAt) {
    record.chunksProcessedAt = row.chunksProcessedAt;
  }
  if (row.chunksCount !== null) {
    record.chunksCount = Number(row.chunksCount);
  }
  if (isResolvedChunkingStrategy(row.chunkingStrategy)) {
    record.chunkingStrategy = row.chunkingStrategy;
  }

  return record;
}

function mapChunkRow(row: FileChunkRow): FileChunk {
  const chunk: FileChunk = {
    id: row.id,
    fileRecordId: row.fileRecordId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount,
    chunkType: row.chunkType,
    chunkSize: row.chunkSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  // PERFORMANCE: We don't fetch full embedding vectors in live queries.
  // Instead we use hasEmbedding flag and embeddingDimensions for UI display.
  // Create a placeholder array with correct length for backward compatibility
  // with UI code that checks `chunk.embedding?.length`.
  // NOTE: Export operations that need actual embedding values must fetch them separately.
  if (row.hasEmbedding && row.embeddingDimensions > 0) {
    // Placeholder array - indicates embedding exists with correct dimensions
    // Values are undefined but length is accurate for UI status display
    chunk.embedding = new Array(row.embeddingDimensions) as number[];
  }
  if (row.embeddingSetId) {
    chunk.embeddingSetId = row.embeddingSetId;
  }
  if (row.embeddingUpdatedAt) {
    chunk.embeddingUpdatedAt = row.embeddingUpdatedAt;
  }
  if (row.embeddingHash) {
    chunk.embeddingHash = row.embeddingHash;
  }

  return chunk;
}

function toCachedRecordSummary(record: FileRecord): CachedRecordSummary {
  return {
    id: record.id,
    name: record.name,
    path: record.path,
    size: record.size,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tokenCount: record.tokenCount,
    chunksCount: record.chunksCount,
    embeddingSetId: record.embeddingSetId,
  };
}

function toCachedChunkSummary(chunk: FileChunk): CachedChunkSummary {
  return {
    id: chunk.id,
    fileRecordId: chunk.fileRecordId,
    chunkIndex: chunk.chunkIndex,
    tokenCount: chunk.tokenCount,
    chunkType: chunk.chunkType,
    embeddingSetId: chunk.embeddingSetId,
  };
}

function buildCollectionFileDataSnapshot(
  collectionId: string,
  records: FileRecord[],
  chunks: FileChunk[]
): CollectionFileDataSnapshot {
  return {
    collectionId,
    records: records.map(toCachedRecordSummary),
    chunks: chunks.map(toCachedChunkSummary),
  };
}

function restoreCachedRecord(summary: CachedRecordSummary): FileRecord {
  const record: FileRecord = {
    id: summary.id,
    name: summary.name,
    path: summary.path,
    size: summary.size,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
  if (summary.tokenCount !== undefined) {
    record.tokenCount = summary.tokenCount;
  }
  if (summary.chunksCount !== undefined) {
    record.chunksCount = summary.chunksCount;
  }
  if (summary.embeddingSetId !== undefined) {
    record.embeddingSetId = summary.embeddingSetId;
  }
  return record;
}

function restoreCachedChunk(summary: CachedChunkSummary): FileChunk {
  const chunk: FileChunk = {
    id: summary.id,
    fileRecordId: summary.fileRecordId,
    chunkIndex: summary.chunkIndex,
    content: '',
    contentHash: '',
    tokenCount: summary.tokenCount,
    chunkType: summary.chunkType,
    chunkSize: 0,
    createdAt: '',
    updatedAt: '',
  };
  if (summary.embeddingSetId !== undefined) {
    chunk.embeddingSetId = summary.embeddingSetId;
  }
  return chunk;
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message ?? null;
  }
  if (typeof error === 'string') {
    return error;
  }
  return null;
}

function isMissingRelation(message: string | null, table: string): boolean {
  if (!message) {
    return false;
  }
  const pattern = new RegExp(`relation .*${table}`, 'i');
  return pattern.test(message);
}

export function useDatabaseDemoData({
  repository,
  chunkRepository: _chunkRepository,
  toast,
  database,
  activeCollectionId,
  isEmbeddingActive = false,
  isImporting = false,
}: UseDatabaseDemoDataOptions): UseDatabaseDemoDataResult {
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);
  const manualRefreshCountRef = useRef(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const cachedRecordsRef = useRef<Map<string, FileRecord[]>>(new Map());
  const cachedChunksRef = useRef<Map<string, FileChunk[]>>(new Map());
  const loadedRecordsRef = useRef<Set<string>>(new Set());
  const loadedChunksRef = useRef<Set<string>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackError, setFallbackError] = useState<Error | null>(null);

  // Global schema verification cache - persists across component remounts
  const globalSchemaVerified = useVectorStatusUIStore((s) => s.schemaVerified);
  // Global file data cache - persists across component remounts during imports
  const globalCachedFileData = useVectorStatusUIStore((s) => s.cachedFileData);
  const setGlobalCachedFileData = useVectorStatusUIStore((s) => s.setCachedFileData);

  void _chunkRepository;

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

    let didRestoreFromGlobalCache = false;

    if (!loadedRecordsRef.current.has(activeCollectionId)) {
      cachedRecordsRef.current.set(
        activeCollectionId,
        globalCachedFileData.records.map(restoreCachedRecord)
      );
      loadedRecordsRef.current.add(activeCollectionId);
      didRestoreFromGlobalCache = true;
    }

    if (!loadedChunksRef.current.has(activeCollectionId)) {
      cachedChunksRef.current.set(
        activeCollectionId,
        globalCachedFileData.chunks.map(restoreCachedChunk)
      );
      loadedChunksRef.current.add(activeCollectionId);
      didRestoreFromGlobalCache = true;
    }

    if (didRestoreFromGlobalCache) {
      setCacheVersion((prev) => prev + 1);
    }
  }, [activeCollectionId, globalCachedFileData]);

  useEffect(() => {
    if (!database) {
      return;
    }
    if (globalSchemaVerified) {
      setFallbackError(null);
    }
  }, [database, globalSchemaVerified]);

  const recordErrorRef = useRef<string | null>(null);
  const chunkErrorRef = useRef<string | null>(null);
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

  const recordQueryParams = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? [activeCollectionId] : undefined),
    [activeCollectionId]
  );

  const chunkQueryParams = useMemo<readonly [string] | undefined>(
    () => (activeCollectionId ? [activeCollectionId] : undefined),
    [activeCollectionId]
  );

  // Pause live queries during import and active embedding. These queries still
  // re-run on every file_chunks mutation, and cache-backed snapshots are enough
  // to keep the database panel responsive while background work is active.
  const liveQueryEnabled = Boolean(
    database && schemaReady && activeCollectionId && !isImporting && !isEmbeddingActive
  );

  const {
    rows: recordRows,
    loading: recordsLoading,
    error: recordsError,
    refresh: refreshRecordsQuery,
  } = usePGliteLiveQuery<FileRecordRow>({
    cacheKey: makeLiveQueryKey('file-records', activeCollectionId),
    query: FILE_RECORDS_LIVE_QUERY,
    ...(recordQueryParams ? { params: recordQueryParams } : {}),
    enabled: liveQueryEnabled,
  });

  const {
    rows: chunkRows,
    loading: chunksLoading,
    error: chunksError,
    refresh: refreshChunksQuery,
  } = usePGliteLiveQuery<FileChunkRow>({
    cacheKey: makeLiveQueryKey('file-chunks', activeCollectionId),
    query: FILE_CHUNKS_LIVE_QUERY,
    ...(chunkQueryParams ? { params: chunkQueryParams } : {}),
    enabled: liveQueryEnabled,
  });

  const records = useMemo<FileRecord[]>(() => {
    if (!(schemaReady && activeCollectionId)) {
      return [];
    }
    return recordRows.map(mapRecordRow);
  }, [recordRows, schemaReady, activeCollectionId]);

  const chunks = useMemo<FileChunk[]>(() => {
    if (!(schemaReady && activeCollectionId)) {
      return [];
    }
    return chunkRows.map(mapChunkRow);
  }, [chunkRows, schemaReady, activeCollectionId]);

  // biome-ignore lint/plugin: This syncs live query results to cache, not fetching data
  useEffect(() => {
    if (!(liveQueryEnabled && activeCollectionId) || recordsLoading) {
      return;
    }
    cachedRecordsRef.current.set(activeCollectionId, records);
    loadedRecordsRef.current.add(activeCollectionId);
    setCacheVersion((prev) => prev + 1);
    setFallbackError(null);
    // Update global cache for persistence across remounts
    const cachedChunksForCollection = cachedChunksRef.current.get(activeCollectionId) ?? [];
    setGlobalCachedFileData(
      buildCollectionFileDataSnapshot(activeCollectionId, records, cachedChunksForCollection)
    );
  }, [activeCollectionId, liveQueryEnabled, records, recordsLoading, setGlobalCachedFileData]);

  // biome-ignore lint/plugin: This syncs live query results to cache, not fetching data
  useEffect(() => {
    if (!(liveQueryEnabled && activeCollectionId) || chunksLoading) {
      return;
    }
    cachedChunksRef.current.set(activeCollectionId, chunks);
    loadedChunksRef.current.add(activeCollectionId);
    setCacheVersion((prev) => prev + 1);
    setFallbackError(null);
    // Update global cache for persistence across remounts
    const cachedRecordsForCollection = cachedRecordsRef.current.get(activeCollectionId) ?? [];
    setGlobalCachedFileData(
      buildCollectionFileDataSnapshot(activeCollectionId, cachedRecordsForCollection, chunks)
    );
  }, [activeCollectionId, liveQueryEnabled, chunks, chunksLoading, setGlobalCachedFileData]);

  const cachedRecords = useMemo<FileRecord[]>(() => {
    if (!(schemaReady && activeCollectionId)) {
      return [];
    }
    return cachedRecordsRef.current.get(activeCollectionId) ?? [];
  }, [activeCollectionId, cacheVersion, schemaReady]);

  const cachedChunks = useMemo<FileChunk[]>(() => {
    if (!(schemaReady && activeCollectionId)) {
      return [];
    }
    return cachedChunksRef.current.get(activeCollectionId) ?? [];
  }, [activeCollectionId, cacheVersion, schemaReady]);

  const fetchSnapshot = useCallback(
    async (options: { includeRecords: boolean; includeChunks: boolean }) => {
      if (!(database && schemaReady && activeCollectionId)) {
        return;
      }
      if (typeof (database as { query?: unknown }).query !== 'function') {
        return;
      }
      const recordParams = recordQueryParams ?? [activeCollectionId];
      const chunkParams = chunkQueryParams ?? [activeCollectionId];
      const [recordsResult, chunksResult] = await Promise.all([
        options.includeRecords
          ? (
              database as {
                query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
              }
            ).query<FileRecordRow>(FILE_RECORDS_LIVE_QUERY, recordParams)
          : Promise.resolve(null),
        options.includeChunks
          ? (
              database as {
                query: <T>(query: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
              }
            ).query<FileChunkRow>(FILE_CHUNKS_LIVE_QUERY, chunkParams)
          : Promise.resolve(null),
      ]);

      if (recordsResult) {
        cachedRecordsRef.current.set(activeCollectionId, recordsResult.rows.map(mapRecordRow));
        loadedRecordsRef.current.add(activeCollectionId);
      }

      if (chunksResult) {
        cachedChunksRef.current.set(activeCollectionId, chunksResult.rows.map(mapChunkRow));
        loadedChunksRef.current.add(activeCollectionId);
      }

      setCacheVersion((prev) => prev + 1);
    },
    [activeCollectionId, chunkQueryParams, database, recordQueryParams, schemaReady]
  );

  useEffect(() => {
    if (liveQueryEnabled) {
      return;
    }
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }
    if (fallbackLoading) {
      return;
    }
    const needsRecords = !loadedRecordsRef.current.has(activeCollectionId);
    const needsChunks = !loadedChunksRef.current.has(activeCollectionId);
    if (!(needsRecords || needsChunks)) {
      return;
    }

    let cancelled = false;
    setFallbackLoading(true);
    setFallbackError(null);

    const runFallback = async () => {
      try {
        await fetchSnapshot({ includeRecords: needsRecords, includeChunks: needsChunks });
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
  }, [activeCollectionId, database, fetchSnapshot, fallbackLoading, liveQueryEnabled, schemaReady]);

  const resolvedRecords = liveQueryEnabled ? records : cachedRecords;
  const resolvedChunks = liveQueryEnabled ? chunks : cachedChunks;

  const loadRecords = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        if (liveQueryEnabled) {
          await refreshRecordsQuery();
        } else {
          await fetchSnapshot({ includeRecords: true, includeChunks: false });
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
    database,
    fetchSnapshot,
    liveQueryEnabled,
    refreshRecordsQuery,
    runManualRefresh,
    schemaReady,
    toast,
  ]);

  const loadChunks = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        if (liveQueryEnabled) {
          await refreshChunksQuery();
        } else {
          await fetchSnapshot({ includeRecords: false, includeChunks: true });
        }
      } catch (error) {
        logger.error('Failed to refresh database chunks', { error });
        const message = extractErrorMessage(error);
        toast({
          title: 'Error',
          description:
            message && isMissingRelation(message, 'file_chunks')
              ? 'Chunk storage is missing or out of date. Run Factory Reset to rebuild the database.'
              : 'Failed to refresh chunks',
          variant: 'destructive',
        });
      }
    });
  }, [
    activeCollectionId,
    database,
    fetchSnapshot,
    liveQueryEnabled,
    refreshChunksQuery,
    runManualRefresh,
    schemaReady,
    toast,
  ]);

  const refreshVisibleData = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }

    await runManualRefresh(async () => {
      if (liveQueryEnabled) {
        await Promise.all([refreshRecordsQuery(), refreshChunksQuery()]);
        return;
      }
      await fetchSnapshot({ includeRecords: true, includeChunks: true });
    });
  }, [
    activeCollectionId,
    database,
    fetchSnapshot,
    liveQueryEnabled,
    refreshChunksQuery,
    refreshRecordsQuery,
    runManualRefresh,
    schemaReady,
  ]);

  const previousLiveQueryEnabledRef = useRef(liveQueryEnabled);

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
    if (!chunksError) {
      chunkErrorRef.current = null;
      return;
    }
    const message = extractErrorMessage(chunksError);
    const description =
      message && isMissingRelation(message, 'file_chunks')
        ? 'Chunk storage is missing or out of date. Run Factory Reset to rebuild the database.'
        : (message ?? 'Failed to load chunks');
    if (chunkErrorRef.current === description) {
      return;
    }
    chunkErrorRef.current = description;
    toast({
      title: 'Error',
      description,
      variant: 'destructive',
    });
  }, [chunksError, toast]);

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
    const location = resolveStorageLocation(repository);
    if (!repository) {
      setDbInfo({
        location,
        testResult: 'Repository not available',
        connected: false,
      });
      return;
    }

    try {
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
  }, [repository]);

  const databasePingHandlers = useMemo(() => {
    const handlers: Array<() => Promise<void>> = [];
    if (typeof window === 'undefined') {
      return handlers;
    }
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
              location: 'Main Process',
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
              location: 'Main Process',
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
  }, []);

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
  }, [database]);

  const refreshing = manualRefreshing || recordsLoading || chunksLoading || fallbackLoading;

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
    records: resolvedRecords,
    chunks: resolvedChunks,
    refreshing,
    dbInfo,
    setDbInfo,
    loadRecords,
    loadChunks,
  };
}
