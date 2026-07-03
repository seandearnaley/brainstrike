import type { PGlite } from '@electric-sql/pglite';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFactoryReset, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Mocks (not real PGlite) so jsdom doesn't hit PGlite 0.4's browser-only
// Worker/Blob paths. Real open/close is covered by `*.browser.test.ts`.

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>;
type ExecMock = Mock<(sql: string) => Promise<unknown>>;
type CloseMock = Mock<() => Promise<void>>;

interface MockTx {
  query: QueryMock;
}

type TransactionCallback = (tx: MockTx) => Promise<unknown> | unknown;
type TransactionMock = Mock<(callback: TransactionCallback) => Promise<unknown>>;

interface MockDb {
  close: CloseMock;
  exec: ExecMock;
  query: QueryMock;
  transaction: TransactionMock;
}

function createMockDb(): MockDb {
  const query: QueryMock = vi.fn(async (sql: string) => {
    if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });

  const transaction: TransactionMock = vi.fn(async (callback: TransactionCallback) => {
    const tx: MockTx = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    return await callback(tx);
  });

  return {
    query,
    exec: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    transaction,
  };
}

function createReadyPgliteProfileBootstrapReport() {
  return {
    checks: [],
    failure: null,
    phase: 'ready',
    profileId: 'test',
    ready: true,
    runtime: {
      engine: 'pglite',
      host: 'electron-utility',
      persistence: 'filesystem',
    },
    search: {
      indexedSearch: 'available',
      message: 'PGlite search is ready',
      ownershipMode: 'primary-store-indexes',
    },
    startedAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T10:00:01.000Z',
  } as const;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

function electronIpcWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DbProvider dbPath="memory://" useElectronIPC={true}>
      {children}
    </DbProvider>
  );
}

function installElectronDbBridge(db: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { db },
    writable: true,
  });
}

describe('DbProvider factoryReset', () => {
  let createdDbs: MockDb[];
  let createPGliteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdDbs = [];

    createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockImplementation(async () => {
        const db = createMockDb();
        createdDbs.push(db);
        // The provider only exercises the four members we mock (query/exec/close/transaction);
        // cast through unknown so the test doesn't have to stub every PGlite member.
        return db as unknown as PGlite;
      });

    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: undefined,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it('exposes a factoryReset function once the DB is initialized', async () => {
    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    expect(typeof result.current.reset).toBe('function');
  });

  it('closes the active DB without provisioning a fresh instance before reload', async () => {
    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    expect(createdDbs).toHaveLength(1);
    const initialDb = createdDbs[0];
    if (!initialDb) {
      throw new Error('Expected initial DB to be created');
    }
    let resetTx: MockTx | null = null;
    initialDb.transaction.mockImplementation(async (callback: TransactionCallback) => {
      resetTx = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }),
      };
      return await callback(resetTx);
    });

    await act(async () => {
      const reset = result.current.reset;
      if (!reset) {
        throw new Error('factoryReset became unavailable before invocation');
      }
      await reset();
    });

    // The reset panel clears renderer state and then reloads the app. Reopening
    // PGlite before that reload can leave the reset UI waiting on database
    // readiness instead of reaching the reload path.
    expect(initialDb.close).toHaveBeenCalledTimes(1);
    expect(resetTx?.query).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_run_usage');
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
    expect(createdDbs).toHaveLength(1);
    expect(result.current.repo).toBeNull();
    expect(result.current.reset).toBeNull();
  });

  it('rejects direct factory reset when assistant run usage cannot be purged', async () => {
    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    expect(createdDbs).toHaveLength(1);
    const initialDb = createdDbs[0];
    if (!initialDb) {
      throw new Error('Expected initial DB to be created');
    }
    const usagePurgeError = new Error('assistant usage purge failed');
    initialDb.transaction.mockImplementation(async (callback: TransactionCallback) => {
      const resetTx: MockTx = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          if (sql === 'DELETE FROM brainstrike_assistant_run_usage') {
            throw usagePurgeError;
          }
          return { rows: [] };
        }),
      };
      return await callback(resetTx);
    });

    await expect(result.current.reset?.()).rejects.toThrow('assistant usage purge failed');
    expect(initialDb.close).not.toHaveBeenCalled();
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
    expect(createdDbs).toHaveLength(1);
    expect(result.current.repo).not.toBeNull();
    expect(result.current.reset).not.toBeNull();
  });

  it('surfaces desktop hard reset failure instead of falling back to direct PGlite', async () => {
    const profileBootstrapReport = createReadyPgliteProfileBootstrapReport();
    installElectronDbBridge({
      clearAll: vi.fn(async () => ({ success: true })),
      diagnostics: vi.fn(async () => null),
      exec: vi.fn(async () => undefined),
      ping: vi.fn(async () => ({ success: true })),
      query: vi.fn(async (sql: string) => {
        if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      }),
      resetLocal: vi.fn(async () => ({ success: false, message: 'disk reset failed' })),
      test: vi.fn(async () => ({ message: 'ok', profileBootstrapReport, success: true })),
    });

    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper: electronIpcWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    await expect(result.current.reset?.()).rejects.toThrow('disk reset failed');
    expect(createPGliteSpy).not.toHaveBeenCalled();
  });

  it('uses desktop resetLocal as the canonical hard reset without pre-clearing tables', async () => {
    const clearAll = vi.fn(async () => {
      throw new Error('clearAll should not run before resetLocal');
    });
    const profileBootstrapReport = createReadyPgliteProfileBootstrapReport();
    const resetLocal = vi.fn(async () => ({ success: true }));
    installElectronDbBridge({
      clearAll,
      diagnostics: vi.fn(async () => null),
      exec: vi.fn(async () => undefined),
      ping: vi.fn(async () => ({ success: true })),
      query: vi.fn(async (sql: string) => {
        if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      }),
      resetLocal,
      test: vi.fn(async () => ({ message: 'ok', profileBootstrapReport, success: true })),
    });

    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper: electronIpcWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    await expect(result.current.reset?.()).resolves.toBeUndefined();
    expect(clearAll).not.toHaveBeenCalled();
    expect(resetLocal).toHaveBeenCalledTimes(1);
    expect(createPGliteSpy).not.toHaveBeenCalled();
  });
});
