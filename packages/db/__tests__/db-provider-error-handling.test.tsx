import type { LogRecord } from '@brainstrike/utils';
import * as utilsModule from '@brainstrike/utils';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

type QueryMock = Mock<[string], Promise<{ rows: unknown[] } | undefined>>;
interface MockDb {
  close: Mock<[], Promise<void>>;
  closed?: boolean;
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

function hasStructuredErrorArg(record: LogRecord, error: Error): boolean {
  return record.args.some(
    (arg) => typeof arg === 'object' && arg !== null && 'err' in arg && arg.err === error
  );
}

describe('DbProvider error handling', () => {
  const activeDatabases: MockDb[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    // Clean up any active databases to prevent unhandled promise rejections
    await Promise.allSettled(
      activeDatabases.map(async (db) => {
        try {
          // Check if database is still open before trying to close
          if (db && typeof db.close === 'function') {
            await db.close();
          }
        } catch {
          // Ignore close errors in cleanup - database might already be closed
        }
      })
    );
    activeDatabases.length = 0;

    vi.restoreAllMocks();
  });

  it('logs initialization errors as structured metadata for browser exports', async () => {
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });
    const initError = new Error('browser visible init failure');

    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(initError);

    renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to initialize database' &&
            hasStructuredErrorArg(record, initError)
        )
      ).toBe(true);
    });

    unsubscribe();
  });

  it('handles database initialization errors gracefully', async () => {
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });
    const initError = new Error('Failed to initialize database');

    // Mock wasmLoader to throw an error
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(initError);

    const { result } = renderHook(
      () => {
        const ctx = useFileRecordRepository();
        // Access the context directly to check error state
        return ctx;
      },
      { wrapper }
    );

    // Wait for the error to be handled
    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to initialize database' &&
            hasStructuredErrorArg(record, initError)
        )
      ).toBe(true);
    });

    // The repository should be null when there's an error
    expect(result.current).toBeNull();

    unsubscribe();
  });

  it('handles migration errors gracefully', async () => {
    const { addLogListener, configureLogger, LogLevel } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    const captured: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });
    const migrationError = new Error('Migration failed');

    // Mock successful database creation but failed migration
    const mockDb = createMockDb();
    activeDatabases.push(mockDb);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockRejectedValue(migrationError);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });

    // Wait for the error to be handled
    await waitFor(() => {
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.ERROR &&
            record.scope === 'DbProvider' &&
            record.message === 'Failed to initialize database' &&
            hasStructuredErrorArg(record, migrationError)
        )
      ).toBe(true);
    });

    // The repository should be null when there's a migration error
    expect(result.current).toBeNull();

    unsubscribe();
  });

  it('handles database close errors in production mode', async () => {
    const closeError = new Error('Failed to close database');

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

    // Create a mock database that fails to close
    const mockDb = createMockDb();
    activeDatabases.push(mockDb);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);
    mockDb.close.mockRejectedValue(closeError);

    const { result, unmount } = renderHook(() => useFileRecordRepository(), { wrapper });

    // Wait for initialization
    await waitFor(() => expect(result.current).toBeDefined());

    // Unmount to trigger cleanup
    unmount();

    // Wait for the close error to be logged
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

  it('prevents concurrent database initialization', async () => {
    let resolveDbCreation: (value: MockDb) => void;
    const dbCreationPromise = new Promise<MockDb>((resolve) => {
      resolveDbCreation = resolve;
    });

    // Mock a slow database creation
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockReturnValue(dbCreationPromise);

    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // First render - this should trigger initialization
    const { unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper: ({ children }) => (
        <DbProvider dbPath="memory://" useElectronIPC={false}>
          {children}
        </DbProvider>
      ),
    });

    // Wait until the initialization call starts deterministically
    await waitFor(() => expect(createPGliteSpy).toHaveBeenCalledTimes(1));

    // Complete the initialization
    const mockDb = createMockDb();
    activeDatabases.push(mockDb);
    resolveDbCreation?.(mockDb);

    // Wait for initialization to complete
    await waitFor(() => {
      expect(createPGliteSpy).toHaveBeenCalledTimes(1);
    });

    unmount();
  });

  it('handles already initialized database gracefully', async () => {
    const mockDb = createMockDb();
    activeDatabases.push(mockDb);
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // First render - initializes database
    const { result, rerender } = renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);

    // Force a re-render with the same wrapper - should not reinitialize
    rerender();

    // Verify database creation wasn't called again
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
  });
});
