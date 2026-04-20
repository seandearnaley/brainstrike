import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFactoryReset, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Why mocks instead of real PGlite:
// PGlite 0.4 detects `typeof window === "object"` (true under jsdom) and routes
// through its browser code path, which spawns helper Workers / Blob URLs that
// jsdom does not implement. The factoryReset flow opens a DB, closes it, then
// reopens a fresh one -- under jsdom that close/reopen cycle deadlocks.
// Real PGlite open/close is exercised by the (browser-mode) `*.browser.test.ts`
// suite. Here we follow the same mock pattern as `clear-data.test.tsx`,
// `db-provider-lifecycle.test.tsx`, etc., so we can assert the orchestration
// (close called, new instance created) without depending on a real WASM DB.

type QueryMock = Mock<[string, unknown[]?], Promise<{ rows: unknown[] } | undefined>>;
type ExecMock = Mock<[string], Promise<unknown>>;
type CloseMock = Mock<[], Promise<void>>;

interface MockTx {
  query: QueryMock;
}

type TransactionCallback = (tx: MockTx) => Promise<unknown> | unknown;
type TransactionMock = Mock<[callback: TransactionCallback], Promise<unknown>>;

interface MockDb {
  close: CloseMock;
  exec: ExecMock;
  query: QueryMock;
  transaction: TransactionMock;
}

function createMockDb(): MockDb {
  const query: QueryMock = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT 1 FROM pg_extension')) {
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

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

describe('DbProvider factoryReset', () => {
  let createdDbs: MockDb[];
  let createPGliteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdDbs = [];

    createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockImplementation(async (_path?: string) => {
        const db = createMockDb();
        createdDbs.push(db);
        // The provider only exercises the four members we mock (query/exec/close/transaction);
        // cast through unknown so the test doesn't have to stub every PGlite member.
        return db as unknown as PGlite;
      });

    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
  });

  afterEach(() => {
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

  it('closes the active DB and provisions a fresh instance on reset', async () => {
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
    const initialCallCount = createPGliteSpy.mock.calls.length;

    await act(async () => {
      const reset = result.current.reset;
      if (!reset) {
        throw new Error('factoryReset became unavailable before invocation');
      }
      await reset();
    });

    // The first DB must have been closed exactly once during the reset, and
    // a brand-new PGlite must have been provisioned by the retry-init path.
    expect(initialDb.close).toHaveBeenCalledTimes(1);
    expect(createPGliteSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
    expect(createdDbs.length).toBeGreaterThanOrEqual(2);
  });
});
