import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import type { useToast } from '@brainstrike/ui';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface DatabaseInfo {
  location: string;
  testResult: string;
  connected: boolean;
}

export interface UseDatabaseDemoDataOptions {
  repository: FileRecordRepository | ElectronFileRecordRepository | null;
  chunkRepository?: FileChunkRepository | ElectronFileChunkRepository | null;
  toast: ReturnType<typeof useToast>['toast'];
  database?: ReturnType<typeof usePGliteDatabase>;
}

interface DatabaseLoaders {
  loadRecords: () => Promise<void>;
  loadChunks: () => Promise<void>;
}

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

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

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
  if (!message) return false;
  const pattern = new RegExp(`relation .*${table}`, 'i');
  return pattern.test(message);
}

function isToastCorruption(message: string | null): boolean {
  return typeof message === 'string' && /pg_toast/i.test(message);
}

function scheduleRetry(ref: MutableRefObject<number>, retry: () => void): boolean {
  if (ref.current >= MAX_RETRY_ATTEMPTS) {
    ref.current = 0;
    return false;
  }
  ref.current += 1;
  const timer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
  timer(() => {
    void retry();
  }, RETRY_DELAY_MS);
  return true;
}

interface RecordLoadErrorContext {
  error: unknown;
  repository: FileRecordRepository | ElectronFileRecordRepository;
  retryRef: MutableRefObject<number>;
  retry: () => Promise<void>;
  setRecords: (records: FileRecord[]) => void;
  toast: ReturnType<typeof useToast>['toast'];
}

async function handleRecordLoadError({
  error,
  repository,
  retryRef,
  retry,
  setRecords,
  toast,
}: RecordLoadErrorContext): Promise<void> {
  console.error('[DatabaseDemo] Failed to load file records', error);
  const message = extractErrorMessage(error);

  if (
    isMissingRelation(message, 'file_records') &&
    scheduleRetry(retryRef, () => {
      void retry();
    })
  ) {
    return;
  }

  if (isToastCorruption(message)) {
    try {
      const fallbackRecords = await repository.findAll();
      setRecords(fallbackRecords);
      retryRef.current = 0;
      return;
    } catch (fallbackError) {
      console.error('[DatabaseDemo] Fallback load records failed', fallbackError);
    }
  }

  retryRef.current = 0;
  toast({
    title: 'Error',
    description: 'Failed to load database records',
    variant: 'destructive',
  });
}

interface ChunkLoadErrorContext {
  error: unknown;
  retryRef: MutableRefObject<number>;
  retry: () => Promise<void>;
  toast: ReturnType<typeof useToast>['toast'];
}

function handleChunkLoadError({ error, retryRef, retry, toast }: ChunkLoadErrorContext): void {
  console.error('[DatabaseDemo] Failed to load chunks', error);
  const message = extractErrorMessage(error);

  if (
    isMissingRelation(message, 'file_chunks') &&
    scheduleRetry(retryRef, () => {
      void retry();
    })
  ) {
    return;
  }

  retryRef.current = 0;
  const safeMessage = message ?? '';
  if (!safeMessage.includes('vector') && !safeMessage.includes('chunks')) {
    toast({
      title: 'Error',
      description: 'Failed to load chunks',
      variant: 'destructive',
    });
  }
}

export function useDatabaseDemoData({
  repository,
  chunkRepository,
  toast,
  database,
}: UseDatabaseDemoDataOptions): UseDatabaseDemoDataResult {
  const [records, setRecords] = useState<FileRecord[]>([]);
  const [chunks, setChunks] = useState<FileChunk[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null);
  const recordRetryRef = useRef(0);
  const chunkRetryRef = useRef(0);

  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      const importedRecords =
        (await repository.findAllWithContent?.()) || (await repository.findAll());
      setRecords(importedRecords);
      recordRetryRef.current = 0;
    } catch (error) {
      await handleRecordLoadError({
        error,
        repository,
        retryRef: recordRetryRef,
        retry: loadRecords,
        setRecords,
        toast,
      });
    } finally {
      setRefreshing(false);
    }
  }, [repository, toast]);

  const loadChunks = useCallback(async () => {
    if (!chunkRepository) {
      setChunks([]);
      return;
    }

    try {
      const allChunks = await chunkRepository.findAll();
      setChunks(allChunks);
      chunkRetryRef.current = 0;
    } catch (error) {
      handleChunkLoadError({
        error,
        retryRef: chunkRetryRef,
        retry: loadChunks,
        toast,
      });
      setChunks([]);
    }
  }, [chunkRepository, toast]);

  const testDatabaseConnection = useCallback(async () => {
    if (!repository) {
      setDbInfo({
        location: 'Unknown',
        testResult: 'Repository not available',
        connected: false,
      });
      return;
    }

    try {
      const count = await repository.count();
      setDbInfo({
        location: 'Database connected via DbProvider',
        testResult: `Successfully connected - ${count} file records found`,
        connected: true,
      });
    } catch (error) {
      setDbInfo({
        location: 'Unknown',
        testResult: `Database connection failed: ${error}`,
        connected: false,
      });
    }
  }, [repository]);

  const databasePingHandlers = useMemo(() => {
    const handlers: Array<() => Promise<void>> = [];
    if (typeof window === 'undefined') return handlers;
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
        } catch (_err) {
          // ignore and allow repository-based test to set state
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
        } catch (_err) {
          // ignore and fall back to repository-based test
        }
      });
    }

    return handlers;
  }, []);

  useEffect(() => {
    if (!repository) {
      setRecords([]);
      setDbInfo(DEFAULT_DB_INFO);
      return;
    }

    void loadRecords();
    void testDatabaseConnection();
  }, [repository, loadRecords, testDatabaseConnection]);

  useEffect(() => {
    if (!chunkRepository) {
      setChunks([]);
      return;
    }
    void loadChunks();
  }, [chunkRepository, loadChunks]);

  useEffect(() => {
    if (databasePingHandlers.length === 0) return;
    let canceled = false;
    const runHandlers = async () => {
      for (const handler of databasePingHandlers) {
        if (canceled) return;
        await handler();
      }
    };
    void runHandlers();
    return () => {
      canceled = true;
    };
  }, [databasePingHandlers]);

  useEffect(() => {
    if (!database) return;
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
      } catch (_err) {
        // ignore
      }
    };
    void fetchInfo();
    return () => {
      canceled = true;
    };
  }, [database]);

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
