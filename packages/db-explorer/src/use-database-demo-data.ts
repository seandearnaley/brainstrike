import {
  type DrizzleFileChunkRepository,
  type DrizzleFileRecordRepository,
  type FileChunk,
  type FileRecord,
  MigrationRunner,
  migrations,
  type usePGliteDatabase,
  usePGliteLiveQuery,
} from '@brainstrike/db';
import { useDatabaseStatusStore, useVectorStatusUIStore } from '@brainstrike/preferences';
import type { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('DatabaseDemoData');

/**
 * Resolve the storage location label based on the runtime environment.
 * This must match the expected values in database-status-item.tsx for proper status bar display.
 * - "Main Process" → displays as "IPC" in status bar (Electron desktop)
 * - "PGlite WASM" → displays as "PGlite WASM" in status bar (Web)
 */
function resolveStorageLocation(repository: DrizzleFileRecordRepository | null): string {
  if (!repository) {
    return 'Unknown';
  }
  // Detect Electron IPC environment via window.electronAPI
  if (typeof window !== 'undefined' && (window as { electronAPI?: unknown }).electronAPI) {
    return 'Main Process';
  }
  return 'PGlite WASM';
}

export type DatabaseInfo = {
  location: string;
  testResult: string;
  connected: boolean;
};

export type UseDatabaseDemoDataOptions = {
  repository: DrizzleFileRecordRepository | null;
  chunkRepository?: DrizzleFileChunkRepository | null;
  toast: ReturnType<typeof useToast>['toast'];
  database?: ReturnType<typeof usePGliteDatabase>;
  activeCollectionId: string | null;
  /** When true, live queries are paused to avoid performance degradation during bulk operations */
  isImporting?: boolean;
};

type DatabaseLoaders = {
  loadRecords: () => Promise<void>;
  loadChunks: () => Promise<void>;
};

export interface UseDatabaseDemoDataResult extends DatabaseLoaders {
  records: FileRecord[];
  chunks: FileChunk[];
  refreshing: boolean;
  dbInfo: DatabaseInfo | null;
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

type FileRecordRow = {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  content: string | null;
  contentHash: string | null;
  tokenCount: number | null;
  processedAt: string | null;
  chunksProcessedAt: string | null;
  chunksCount: number | null;
  chunkingStrategy: string | null;
  /** Boolean flag - embedding exists but not fetched for performance */
  hasEmbedding: boolean;
  embeddingSetId: string | null;
};

type FileChunkRow = {
  id: string;
  fileRecordId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  chunkType: FileChunk['chunkType'];
  chunkSize: number;
  /** Boolean flag - embedding exists but not fetched for performance */
  hasEmbedding: boolean;
  /** Embedding dimensions - computed from ARRAY_LENGTH for display without fetching full vector */
  embeddingDimensions: number;
  embeddingSetId: string | null;
  embeddingUpdatedAt: string | null;
  embeddingHash: string | null;
  createdAt: string;
  updatedAt: string;
};

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
  if (
    row.chunkingStrategy === 'sentence' ||
    row.chunkingStrategy === 'token' ||
    row.chunkingStrategy === 'recursive'
  ) {
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
  const schemaStateRef = useRef<{
    db: ReturnType<typeof usePGliteDatabase> | null;
    ensured: boolean;
    promise: Promise<void> | null;
  }>({
    db: null,
    ensured: false,
    promise: null,
  });

  // Global schema verification cache - persists across component remounts
  const globalSchemaVerified = useVectorStatusUIStore((s) => s.schemaVerified);
  const setGlobalSchemaVerified = useVectorStatusUIStore((s) => s.setSchemaVerified);
  // Global file data cache - persists across component remounts during imports
  const globalCachedFileData = useVectorStatusUIStore((s) => s.cachedFileData);
  const setGlobalCachedFileData = useVectorStatusUIStore((s) => s.setCachedFileData);

  void _chunkRepository;

  // biome-ignore lint/plugin: Sync state when database changes - necessary for tracking DB lifecycle
  useEffect(() => {
    const previousDb = schemaStateRef.current.db;
    const databaseChanged = previousDb !== database;

    if (databaseChanged) {
      schemaStateRef.current = {
        db: database ?? null,
        ensured: false,
        promise: null,
      };

      // Only clear caches if database ACTUALLY changed (not just remount)
      // On remount with same database, keep caches intact
      if (previousDb !== null && database !== null) {
        cachedRecordsRef.current.clear();
        cachedChunksRef.current.clear();
        loadedRecordsRef.current.clear();
        loadedChunksRef.current.clear();
        setCacheVersion((prev) => prev + 1);
        setFallbackLoading(false);
        setFallbackError(null);
        // Reset schema state when database changes
        setSchemaReady(false);
      }
    }
  }, [database]);

  // Restore cached data from global store on mount
  useEffect(() => {
    if (globalCachedFileData && activeCollectionId === globalCachedFileData.collectionId) {
      // Restore from global cache if it matches the active collection
      const restoredRecords: FileRecord[] = globalCachedFileData.records.map((r) => {
        const record: FileRecord = {
          id: r.id,
          name: r.name,
          path: r.path,
          size: r.size,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
        if (r.tokenCount !== undefined) {
          record.tokenCount = r.tokenCount;
        }
        if (r.chunksCount !== undefined) {
          record.chunksCount = r.chunksCount;
        }
        if (r.embeddingSetId !== undefined) {
          record.embeddingSetId = r.embeddingSetId;
        }
        return record;
      });
      const restoredChunks: FileChunk[] = globalCachedFileData.chunks.map((c) => {
        const chunk: FileChunk = {
          id: c.id,
          fileRecordId: c.fileRecordId,
          chunkIndex: c.chunkIndex,
          content: '', // Not cached - will be loaded on demand
          contentHash: '',
          tokenCount: c.tokenCount,
          chunkType: c.chunkType,
          chunkSize: 0,
          createdAt: '',
          updatedAt: '',
        };
        if (c.embeddingSetId !== undefined) {
          chunk.embeddingSetId = c.embeddingSetId;
        }
        return chunk;
      });
      cachedRecordsRef.current.set(activeCollectionId, restoredRecords);
      cachedChunksRef.current.set(activeCollectionId, restoredChunks);
      loadedRecordsRef.current.add(activeCollectionId);
      loadedChunksRef.current.add(activeCollectionId);
      setCacheVersion((prev) => prev + 1);
    }
  }, [activeCollectionId, globalCachedFileData]);

  // Schema verification effect - runs migrations if needed, then enables queries
  // Key principle: schemaReady is set INSIDE the promise to avoid race conditions
  useEffect(() => {
    if (!database) {
      setSchemaReady(false);
      return;
    }

    // If schema was already verified globally (persisted across remounts), skip migration
    // We only check globalSchemaVerified because the ref resets on remount but the store persists
    if (globalSchemaVerified) {
      schemaStateRef.current.ensured = true; // Sync ref with global state
      setSchemaReady(true);
      return;
    }

    // If we already have a running promise, wait for it
    if (schemaStateRef.current.promise) {
      let cancelled = false;
      schemaStateRef.current.promise
        .then(() => {
          if (!cancelled) {
            setSchemaReady(true);
          }
        })
        .catch(() => {
          // Error already handled by original promise
        });
      return () => {
        cancelled = true;
      };
    }

    // Start migration - set schemaReady and globalSchemaVerified INSIDE the promise
    // to avoid race conditions from re-renders triggered by Zustand updates
    schemaStateRef.current.promise = (async () => {
      const runner = new MigrationRunner(
        database as unknown as ConstructorParameters<typeof MigrationRunner>[0]
      );
      await runner.initialize();
      await runner.up(migrations);
      schemaStateRef.current.ensured = true;
      // Set BOTH states inside the promise - this is atomic from React's perspective
      setGlobalSchemaVerified(true);
      setSchemaReady(true);
    })().catch((error) => {
      schemaStateRef.current.promise = null;
      logger.error('Failed to verify database schema', { error });
      setSchemaReady(false);
      toast({
        title: 'Database Error',
        description: 'Unable to initialize local database schema. Try Factory Reset.',
        variant: 'destructive',
      });
      throw error;
    });

    // No cleanup needed - the promise handles state atomically
    return;
  }, [database, globalSchemaVerified, setGlobalSchemaVerified, toast]);

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

  // Pause live queries during IMPORT to avoid performance degradation
  // Live queries fire on every DB mutation, causing O(n²) work during bulk inserts
  //
  // NOTE: We do NOT pause during embedding (isEmbeddingActive) because:
  // 1. Embedding updates file_chunks.embedding which we no longer fetch in live queries
  // 2. Users need to browse/search collections while embedding runs in background
  // 3. Embedding worker runs in separate thread and shouldn't block UI
  const liveQueryEnabled = Boolean(database && schemaReady && activeCollectionId && !isImporting);

  const {
    rows: recordRows,
    loading: recordsLoading,
    error: recordsError,
    refresh: refreshRecordsQuery,
  } = usePGliteLiveQuery<FileRecordRow>({
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
    setGlobalCachedFileData({
      collectionId: activeCollectionId,
      records: records.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        size: r.size,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tokenCount: r.tokenCount,
        chunksCount: r.chunksCount,
        embeddingSetId: r.embeddingSetId,
      })),
      chunks: cachedChunksForCollection.map((c) => ({
        id: c.id,
        fileRecordId: c.fileRecordId,
        chunkIndex: c.chunkIndex,
        tokenCount: c.tokenCount,
        chunkType: c.chunkType,
        embeddingSetId: c.embeddingSetId,
      })),
    });
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
    setGlobalCachedFileData({
      collectionId: activeCollectionId,
      records: cachedRecordsForCollection.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.path,
        size: r.size,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tokenCount: r.tokenCount,
        chunksCount: r.chunksCount,
        embeddingSetId: r.embeddingSetId,
      })),
      chunks: chunks.map((c) => ({
        id: c.id,
        fileRecordId: c.fileRecordId,
        chunkIndex: c.chunkIndex,
        tokenCount: c.tokenCount,
        chunkType: c.chunkType,
        embeddingSetId: c.embeddingSetId,
      })),
    });
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
