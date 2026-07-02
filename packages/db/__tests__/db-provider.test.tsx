import type { LogRecord } from '@brainstrike/utils';
import * as utilsModule from '@brainstrike/utils';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfileBootstrapReport } from '../src/bootstrap/profile-bootstrap-report';
import {
  DbProvider,
  useAssistantMemoryDbClient,
  useBrainstrikeDatabase,
  useBrainstrikeDbClient,
  useBrainstrikeExecutionDbClient,
  useBrainstrikeLiveQueryCapability,
  useBrainstrikeSchemaReadyCapability,
  useEmbeddingWorkerDbClient,
  useFileRecordRepository,
  useOptionalBrainstrikeDatabase,
  useOptionalBrainstrikeDbClient,
  usePGliteDatabase,
} from '../src/db-provider';
import {
  resolveBrainstrikeSchemaReadyCapability,
  startDbProviderLazyInitialization,
} from '../src/db-provider-schema-readiness';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

type QueryMock = Mock<[string], Promise<{ rows: unknown[] } | undefined>>;
interface MockDb {
  close: Mock<[], Promise<void>>;
  exec: Mock<[string], Promise<unknown>>;
  query: QueryMock;
  transaction?: Mock<
    [callback: (tx: { query: QueryMock }) => Promise<unknown> | unknown],
    Promise<unknown>
  >;
}

function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  const baseQuery: QueryMock = vi.fn(async (sql: string) => {
    if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });
  return {
    query: baseQuery,
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    transaction: vi.fn(async (callback) => callback({ query: baseQuery })),
    ...overrides,
  };
}

function hasStructuredErrorArg(record: LogRecord, error: Error): boolean {
  return record.args.some(
    (arg) => typeof arg === 'object' && arg !== null && 'err' in arg && arg.err === error
  );
}

function createReadyBootstrapReport(
  engine: Parameters<typeof createProfileBootstrapReport>[0]['runtime']['engine']
) {
  return createProfileBootstrapReport({
    checks: [
      {
        id: 'store.open',
        label: 'database store opened',
        required: true,
        status: 'passed',
      },
    ],
    phase: 'ready',
    profileId: 'test',
    runtime: {
      engine,
      host: 'node',
      persistence: 'filesystem',
    },
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:01.000Z',
  });
}

describe('DbProvider', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });
  it('exposes FileRecordRepository via context', async () => {
    // Mock the wasmLoader to return a real PGlite instance without WASM loading
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined(), {
      timeout: 10_000, // 10 seconds timeout for CI
    });
  });

  it('returns null when hook used outside provider', () => {
    const { result } = renderHook(() => useFileRecordRepository());
    expect(result.current).toBeNull();
  });

  it('exposes the database through runtime-neutral hook aliases', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);

    const { result } = renderHook(
      () => ({
        assistantMemoryClient: useAssistantMemoryDbClient(),
        client: useBrainstrikeDbClient(),
        db: useBrainstrikeDatabase(),
        embeddingWorkerClient: useEmbeddingWorkerDbClient(),
        executionClient: useBrainstrikeExecutionDbClient(),
        liveQueryAvailable: useBrainstrikeLiveQueryCapability(),
        optionalClient: useOptionalBrainstrikeDbClient(),
        optionalDb: useOptionalBrainstrikeDatabase(),
        pgliteDb: usePGliteDatabase(),
        schemaReady: useBrainstrikeSchemaReadyCapability(),
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.db).toBeTruthy();
      expect(result.current.client).toBe(result.current.db);
      expect(result.current.assistantMemoryClient).toEqual({
        db: result.current.db,
        runtimeEngine: 'pglite',
      });
      expect(result.current.embeddingWorkerClient).toEqual({
        db: result.current.db,
        runtimeEngine: 'pglite',
      });
      expect(result.current.executionClient).toEqual({
        db: result.current.db,
        runtimeEngine: 'pglite',
        sqlCapabilities: {
          dialect: 'postgres',
          features: [
            'data-modifying-cte',
            'jsonb',
            'postgres-fts',
            'postgres-vector',
            'skip-locked',
            'trigram',
          ],
        },
      });
      expect(result.current.optionalClient).toBe(result.current.db);
      expect(result.current.optionalDb).toBe(result.current.db);
      expect(result.current.pgliteDb).toBe(result.current.db);
      expect(result.current.liveQueryAvailable).toBe(true);
      expect(result.current.schemaReady).toBe(true);
    });
  });

  it('returns null from the optional runtime-neutral database hook outside provider', () => {
    const { result } = renderHook(() => ({
      client: useOptionalBrainstrikeDbClient(),
      db: useOptionalBrainstrikeDatabase(),
      executionClient: useBrainstrikeExecutionDbClient(),
      liveQueryAvailable: useBrainstrikeLiveQueryCapability(),
      schemaReady: useBrainstrikeSchemaReadyCapability(),
    }));
    expect(result.current.client).toBeNull();
    expect(result.current.db).toBeNull();
    expect(result.current.executionClient).toBeNull();
    expect(result.current.liveQueryAvailable).toBe(false);
    expect(result.current.schemaReady).toBe(false);
  });

  it('does not report schema readiness for unsupported bootstrap runtime engines', () => {
    const readyPgliteReport = createReadyBootstrapReport('pglite');

    expect(
      resolveBrainstrikeSchemaReadyCapability({
        db: createMockDb(),
        error: new Error('schema failed'),
        initializationStatus: 'ready',
        profileBootstrapReport: readyPgliteReport,
        ready: true,
      })
    ).toBe(false);

    expect(
      resolveBrainstrikeSchemaReadyCapability({
        db: createMockDb(),
        error: null,
        initializationStatus: 'ready',
        profileBootstrapReport: createReadyBootstrapReport('libsql'),
        ready: true,
      })
    ).toBe(false);
  });

  it('logs lazy initialization rejection from schema-ready consumers', async () => {
    const error = new Error('lazy schema init failed');
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });

    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });

    startDbProviderLazyInitialization(() => Promise.reject(error));

    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to lazy-initialize database' &&
            hasStructuredErrorArg(record, error)
        )
      ).toBe(true);
    });

    unsubscribe();
  });

  it('runs migrations on mount and closes db on unmount in production', async () => {
    const mockDb = createMockDb();
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as undefined);
    mockDb.close.mockResolvedValue(undefined);
    const closeSpy = mockDb.close;

    // Mock production environment
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);

    const { result, unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });

    await waitFor(() => expect(createPGliteSpy).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    await waitFor(() => expect(migrateSpy).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    await waitFor(() => expect(result.current).toBeDefined(), {
      timeout: 10_000,
    });
    unmount();

    // Wait for the async close operation to complete
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    isDevEnvSpy.mockRestore();
  });

  it('keeps db open on unmount in development (Fast Refresh)', async () => {
    const mockDb = createMockDb();
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as undefined);
    mockDb.close.mockResolvedValue(undefined);
    const closeSpy = mockDb.close;

    // Mock development environment
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(true);

    const { result, unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });

    await waitFor(() => expect(createPGliteSpy).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    await waitFor(() => expect(migrateSpy).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    await waitFor(() => expect(result.current).toBeDefined(), {
      timeout: 10_000,
    });
    unmount();

    // In development, the database should NOT be closed to avoid Fast Refresh issues
    expect(closeSpy).toHaveBeenCalledTimes(0);
    isDevEnvSpy.mockRestore();
  });

  it('waits for migrations before providing context', async () => {
    // Mock the database creation to succeed
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);

    // Mock the migration to be delayed
    let resolveMigration: () => void;
    const migratePromise = new Promise<void>((resolve) => {
      resolveMigration = resolve;
    });
    vi.spyOn(migrations, 'migrate').mockReturnValue(migratePromise);

    const { result } = renderHook(
      () => {
        const repo = useFileRecordRepository();
        return repo;
      },
      { wrapper }
    );
    expect(result.current).toBeNull();
    resolveMigration?.();
    await waitFor(() => expect(result.current).not.toBeNull(), {
      timeout: 10_000, // 10 seconds timeout for CI
    });
  });

  it('returns null and logs error when initialization fails', async () => {
    const error = new Error('init failed');
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });

    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });

    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(error);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to initialize database' &&
            hasStructuredErrorArg(record, error)
        )
      ).toBe(true);
    });

    expect(result.current).toBeNull();
    unsubscribe();
  });

  it('logs an error if closing the db fails on unmount', async () => {
    const mockDb = createMockDb();
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // Mock production environment but enable logging for the test
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);
    // Configure logger to enable logging in production for this test
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });

    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });

    const closeError = new Error('close failed');
    mockDb.close.mockRejectedValue(closeError);
    const closeSpy = mockDb.close;

    const { result, unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBeDefined(), { timeout: 10_000 });

    expect(() => unmount()).not.toThrow();

    // Wait for the async close operation to complete
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });

    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to close database:' &&
            record.args.includes(closeError)
        )
      ).toBe(true);
    });
    unsubscribe();
    isDevEnvSpy.mockRestore();
  });
});
