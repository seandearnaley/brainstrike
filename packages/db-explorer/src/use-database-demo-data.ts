import {
  type ElectronFileChunkRepository,
  type ElectronFileRecordRepository,
  type FileChunk,
  type FileChunkRepository,
  type FileRecord,
  type FileRecordRepository,
  MigrationRunner,
  migrations,
  type usePGliteDatabase,
  usePGliteLiveQuery,
} from '@brainstrike/db';
import { useDatabaseStatusStore } from '@brainstrike/preferences';
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
  repository: FileRecordRepository | ElectronFileRecordRepository | null
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

export type DatabaseInfo = {
  location: string;
  testResult: string;
  connected: boolean;
};

export type UseDatabaseDemoDataOptions = {
  repository: FileRecordRepository | ElectronFileRecordRepository | null;
  chunkRepository?: FileChunkRepository | ElectronFileChunkRepository | null;
  toast: ReturnType<typeof useToast>['toast'];
  database?: ReturnType<typeof usePGliteDatabase>;
  activeCollectionId: string | null;
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
    embedding,
    embedding_set_id AS "embeddingSetId"
  FROM file_records
  WHERE embedding_set_id = $1
  ORDER BY updated_at DESC
`.trim();

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
    embedding,
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
  embedding: unknown;
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
  embedding: unknown;
  embeddingSetId: string | null;
  embeddingUpdatedAt: string | null;
  embeddingHash: string | null;
  createdAt: string;
  updatedAt: string;
};

function coerceNumericArray(values: ArrayLike<unknown>): number[] | undefined {
  const normalized = Array.from(values)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
  return normalized.length ? normalized : undefined;
}

function parseStringEmbedding(value: string): number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.length) {
    return;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return coerceNumericArray(parsed);
    }
  } catch {
    // fall through to manual parsing
  }

  const withoutBrackets = trimmed.replace(/^\s*\[?/, '').replace(/\]?\s*$/, '');
  if (!withoutBrackets.length) {
    return;
  }
  const parts = withoutBrackets.split(/,\s*/).filter(Boolean);
  if (!parts.length) {
    return;
  }
  return coerceNumericArray(parts);
}

function normalizeEmbeddingVector(value: unknown): number[] | undefined {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    return coerceNumericArray(value);
  }

  if (ArrayBuffer.isView(value)) {
    return coerceNumericArray(value as unknown as ArrayLike<number>);
  }

  if (typeof value === 'string') {
    return parseStringEmbedding(value);
  }

  return;
}

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
  const embeddingVector = normalizeEmbeddingVector(row.embedding);
  if (embeddingVector?.length) {
    record.embedding = embeddingVector;
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

  const embeddingVector = normalizeEmbeddingVector(row.embedding);
  if (embeddingVector?.length) {
    chunk.embedding = embeddingVector;
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
}: UseDatabaseDemoDataOptions): UseDatabaseDemoDataResult {
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null);
  const [schemaReady, setSchemaReady] = useState(false);
  const manualRefreshCountRef = useRef(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const schemaStateRef = useRef<{
    db: ReturnType<typeof usePGliteDatabase> | null;
    ensured: boolean;
    promise: Promise<void> | null;
  }>({
    db: null,
    ensured: false,
    promise: null,
  });

  void _chunkRepository;

  useEffect(() => {
    if (schemaStateRef.current.db !== database) {
      schemaStateRef.current = {
        db: database ?? null,
        ensured: false,
        promise: null,
      };
      setSchemaReady(false);
    }
  }, [database]);

  const ensureSchema = useCallback(async () => {
    if (!database) {
      return;
    }

    if (!schemaStateRef.current.promise) {
      schemaStateRef.current.promise = (async () => {
        const runner = new MigrationRunner(
          database as unknown as ConstructorParameters<typeof MigrationRunner>[0]
        );
        await runner.initialize();
        await runner.up(migrations);
        schemaStateRef.current.ensured = true;
      })().catch((error) => {
        schemaStateRef.current.promise = null;
        throw error;
      });
    }

    await schemaStateRef.current.promise;
  }, [database]);

  useEffect(() => {
    if (!database) {
      setSchemaReady(false);
      return;
    }

    let cancelled = false;
    ensureSchema()
      .then(() => {
        if (!cancelled) {
          setSchemaReady(true);
        }
      })
      .catch((error) => {
        logger.error('Failed to verify database schema', { error });
        if (!cancelled) {
          setSchemaReady(false);
          toast({
            title: 'Database Error',
            description: 'Unable to initialize local database schema. Try Factory Reset.',
            variant: 'destructive',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [database, ensureSchema, toast]);

  const recordErrorRef = useRef<string | null>(null);
  const chunkErrorRef = useRef<string | null>(null);

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

  const {
    rows: recordRows,
    loading: recordsLoading,
    error: recordsError,
    refresh: refreshRecordsQuery,
  } = usePGliteLiveQuery<FileRecordRow>({
    query: FILE_RECORDS_LIVE_QUERY,
    ...(recordQueryParams ? { params: recordQueryParams } : {}),
    enabled: Boolean(database && schemaReady && activeCollectionId),
  });

  const {
    rows: chunkRows,
    loading: chunksLoading,
    error: chunksError,
    refresh: refreshChunksQuery,
  } = usePGliteLiveQuery<FileChunkRow>({
    query: FILE_CHUNKS_LIVE_QUERY,
    ...(chunkQueryParams ? { params: chunkQueryParams } : {}),
    enabled: Boolean(database && schemaReady && activeCollectionId),
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

  const loadRecords = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        await refreshRecordsQuery();
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
  }, [database, schemaReady, activeCollectionId, refreshRecordsQuery, runManualRefresh, toast]);

  const loadChunks = useCallback(async () => {
    if (!(database && schemaReady && activeCollectionId)) {
      return;
    }

    await runManualRefresh(async () => {
      try {
        await refreshChunksQuery();
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
  }, [database, schemaReady, activeCollectionId, refreshChunksQuery, runManualRefresh, toast]);

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

  const refreshing = manualRefreshing || recordsLoading || chunksLoading;

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
    records,
    chunks,
    refreshing,
    dbInfo,
    setDbInfo,
    loadRecords,
    loadChunks,
  };
}
