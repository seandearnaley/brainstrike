// @vitest-environment jsdom
import type { LogRecord } from '@brainstrike/logging';
import * as loggingModule from '@brainstrike/logging';
import * as utilsModule from '@brainstrike/utils';
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import { useFileRecordRepository } from '../src/use-db';
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
    close: vi.fn(async () => {}),
    exec: vi.fn(async () => {}),
    query: baseQuery,
    ...overrides,
  };
}

function isStructuredError(value: unknown, error: Error): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === error.name &&
    'message' in value &&
    value.message === error.message
  );
}

function hasStructuredErrorArg(record: LogRecord, error: Error): boolean {
  return record.args.some(
    (arg) =>
      isStructuredError(arg, error) ||
      (typeof arg === 'object' && arg !== null && 'err' in arg && isStructuredError(arg.err, error))
  );
}

describe('DbProvider', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults. Use the ESM namespace import —
    // a bare CJS require() bypasses vite aliases (native node resolution) and
    // resets the DIST logger copy instead of the src instance under test
    // (incident #1066 class; surfaced by the threads-pool mutation lane).
    loggingModule.resetLogger();
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
    const { addLogListener, LogLevel } = await import('@brainstrike/logging');

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

  it.each(['close failed', 'filesystem closed unexpectedly'])(
    'emits a structured diagnostic when closing fails: %s',
    async (message: string): Promise<void> => {
      const mockDb = createMockDb();
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

      // Mock production environment but enable logging for the test
      const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);
      const { addLogListener, LogLevel } = await import('@brainstrike/logging');

      const captured: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => {
        if (record.scope === 'DbProvider') {
          captured.push(record);
        }
      });

      const closeError = new Error(message);
      mockDb.close.mockRejectedValue(closeError);
      const closeSpy = mockDb.close;

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper,
      });
      await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 10_000 });

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
              hasStructuredErrorArg(record, closeError) &&
              record.args.some(
                (arg) =>
                  typeof arg === 'object' &&
                  arg !== null &&
                  'code' in arg &&
                  arg.code === 'database_close_failed'
              )
          )
        ).toBe(true);
      });
      const closeRecords = captured.filter(
        (record) => record.message === 'Failed to close database:'
      );
      expect(closeRecords).toHaveLength(1);
      const record = closeRecords[0];
      if (!record) {
        throw new Error('Expected a close failure record');
      }
      expect(
        logRecordToDiagnosticEvent(record, {
          appVersion: 'test',
          makeId: () => 'close-failure',
          platform: 'test',
          sessionId: 'test',
          source: 'renderer',
        })
      ).toMatchObject({
        code: 'database_close_failed',
        context: { storage: 'direct' },
        scope: 'DbProvider',
        severity: 'error',
      });
      unsubscribe();
      isDevEnvSpy.mockRestore();
    }
  );
});
