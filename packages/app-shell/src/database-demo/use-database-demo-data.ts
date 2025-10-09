import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecord,
  FileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import { MigrationRunner, migrations } from '@brainstrike/db';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  const schemaStateRef = useRef<{
    db: ReturnType<typeof usePGliteDatabase> | null;
    ensured: boolean;
    promise: Promise<void> | null;
  }>({
    db: null,
    ensured: false,
    promise: null,
  });

  useEffect(() => {
    if (schemaStateRef.current.db !== database) {
      schemaStateRef.current = {
        db: database ?? null,
        ensured: false,
        promise: null,
      };
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
    if (!database) return;
    ensureSchema().catch((error) => {
      console.error('[DatabaseDemo] Failed to verify schema', error);
    });
  }, [database, ensureSchema]);

  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      await ensureSchema();
      const importedRecords = await repository.findAll();
      setRecords(importedRecords);
    } catch (error) {
      console.error('[DatabaseDemo] Failed to load file records', error);
      const message = extractErrorMessage(error);
      const description = (() => {
        if (message && isMissingRelation(message, 'file_records')) {
          return 'File storage is missing or needs migration. Run Factory Reset to rebuild the database.';
        }
        if (message && /pg_toast/i.test(message)) {
          return 'Stored file contents appear corrupted. Run Factory Reset in settings and retry.';
        }
        return 'Failed to load database records';
      })();
      toast({
        title: 'Error',
        description,
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  }, [repository, ensureSchema, toast]);

  const loadChunks = useCallback(async () => {
    if (!chunkRepository) {
      setChunks([]);
      return;
    }

    try {
      await ensureSchema();
      const allChunks = await chunkRepository.findAll();
      setChunks(allChunks);
    } catch (error) {
      console.error('[DatabaseDemo] Failed to load chunks', error);
      const message = extractErrorMessage(error);
      toast({
        title: 'Error',
        description:
          message && isMissingRelation(message, 'file_chunks')
            ? 'Chunk storage is missing or out of date. Run Factory Reset to rebuild the database.'
            : 'Failed to load chunks',
        variant: 'destructive',
      });
      setChunks([]);
    }
  }, [chunkRepository, ensureSchema, toast]);

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
