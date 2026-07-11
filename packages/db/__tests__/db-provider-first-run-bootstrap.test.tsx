/**
 * DbProvider wiring for the first-run fast bootstrap: the bootstrap check runs
 * BEFORE the long-lived worker client opens a browser idb:// store, never runs
 * for non-idb paths, and a bootstrap failure surfaces as the provider's
 * initialization error (no silent fallback to the slow path).
 */

import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { maybeBootstrap } = vi.hoisted(() => ({ maybeBootstrap: vi.fn() }));
const orderedCalls: string[] = [];
const pgliteWorkerCreate = vi.fn();
const workerConstructor = vi.fn();

vi.mock('@electric-sql/pglite', () => ({
  PGlite: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    this.exec = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
    this.transaction = vi.fn();
  }),
}));

vi.mock('@electric-sql/pglite/live', () => ({ live: {} }));
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: {} }));

vi.mock('@electric-sql/pglite/worker', () => ({
  PGliteWorker: {
    create: pgliteWorkerCreate,
  },
}));

vi.mock('../src/migrations/bootstrap', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/migrations/bootstrap')>();
  return {
    migrate: vi.fn().mockResolvedValue(undefined),
    PGVECTOR_EXTENSION_PRESENCE_QUERY: original.PGVECTOR_EXTENSION_PRESENCE_QUERY,
  };
});

vi.mock('../src/browser-first-run-bootstrap', () => ({
  maybeBootstrapBrowserFirstRunStore: maybeBootstrap,
}));

import { DbProvider, useDbProviderError, useFileRecordRepository } from '../src/db-provider';

function makeWrapper(dbPath?: string) {
  return function wrapper({ children }: { children: React.ReactNode }) {
    return <DbProvider dbPath={dbPath}>{children}</DbProvider>;
  };
}

describe('DbProvider first-run bootstrap wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderedCalls.length = 0;

    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: workerConstructor,
      writable: true,
    });
    workerConstructor.mockImplementation(function WorkerMock(
      this: Record<string, unknown>,
      url: URL,
      options: WorkerOptions
    ) {
      this.url = url;
      this.options = options;
      this.terminate = vi.fn();
    });

    maybeBootstrap.mockImplementation(async () => {
      orderedCalls.push('bootstrap');
      return { performed: true, recoveredPartialBootstrap: false };
    });

    pgliteWorkerCreate.mockImplementation(async () => {
      orderedCalls.push('worker-create');
      return {
        close: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn().mockResolvedValue(undefined),
        live: { query: vi.fn() },
        query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
        transaction: vi.fn(),
      };
    });
  });

  it('runs the bootstrap check before the long-lived worker client opens the idb store', async () => {
    await act(async () => {
      renderHook(() => useFileRecordRepository(), { wrapper: makeWrapper('idb://web-pg18') });
    });

    expect(maybeBootstrap).toHaveBeenCalledTimes(1);
    expect(maybeBootstrap).toHaveBeenCalledWith(
      'idb://web-pg18',
      expect.objectContaining({
        bootstrapStore: expect.any(Function),
        deleteStore: expect.any(Function),
      })
    );
    expect(orderedCalls).toEqual(['bootstrap', 'worker-create']);
  });

  it("wires the recovery deleteStore with blockedBehavior 'resolve' so it cannot hang init", async () => {
    await act(async () => {
      renderHook(() => useFileRecordRepository(), { wrapper: makeWrapper('idb://web-pg18') });
    });

    const deps = maybeBootstrap.mock.calls[0]?.[1] as {
      deleteStore: (dataDir: string) => Promise<{ readonly blocked: boolean }>;
    };
    const { wasmLoader } = await import('../src/wasm-loader');
    const deleteSpy = vi.spyOn(wasmLoader, 'deleteIndexedDB').mockResolvedValue({ blocked: false });
    try {
      await deps.deleteStore('idb://web-pg18');
      // A BLOCKED delete must settle reporting `blocked: true` so torn-store
      // recovery can throw its loud "close other tabs" error directly instead
      // of waiting forever on a connection held by another tab (factory reset
      // keeps the waiting default because its own teardown closes the holders).
      expect(deleteSpy).toHaveBeenCalledExactlyOnceWith('idb://web-pg18', {
        blockedBehavior: 'resolve',
      });
    } finally {
      deleteSpy.mockRestore();
    }
  });

  it('skips the bootstrap check for non-idb data dirs', async () => {
    await act(async () => {
      renderHook(() => useFileRecordRepository(), { wrapper: makeWrapper('memory://unit') });
    });

    expect(maybeBootstrap).not.toHaveBeenCalled();
  });

  it('surfaces a bootstrap failure as the provider initialization error', async () => {
    maybeBootstrap.mockRejectedValue(new Error('first-run bootstrap exploded'));

    const rendered = await act(async () =>
      renderHook(
        () => {
          useFileRecordRepository();
          return useDbProviderError();
        },
        { wrapper: makeWrapper('idb://web-pg18') }
      )
    );

    expect(rendered.result.current?.message).toBe('first-run bootstrap exploded');
    expect(pgliteWorkerCreate).not.toHaveBeenCalled();
  });
});
