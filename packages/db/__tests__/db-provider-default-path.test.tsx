import os from 'node:os';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgliteWorkerCreate = vi.fn();
const workerConstructor = vi.fn();

vi.mock('@electric-sql/pglite', () => ({
  PGlite: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.query = vi.fn();
    this.exec = vi.fn();
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('@electric-sql/pglite/live', () => ({
  live: {},
}));

vi.mock('@electric-sql/pglite/vector', () => ({
  vector: {},
}));

vi.mock('@electric-sql/pglite/worker', () => ({
  PGliteWorker: {
    create: pgliteWorkerCreate,
  },
}));

vi.mock('../src/migrations/bootstrap', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

import { PGlite } from '@electric-sql/pglite';
import { DbProvider, getDefaultDbPath, useFileRecordRepository } from '../src/db-provider';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider>{children}</DbProvider>;
}

describe('DbProvider default dbPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    pgliteWorkerCreate.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn().mockResolvedValue(undefined),
      live: { query: vi.fn() },
      query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      transaction: vi.fn().mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          await fn({
            exec: vi.fn().mockResolvedValue(undefined),
            query: vi.fn().mockResolvedValue({ rows: [] }),
          })
      ),
    });
  });

  it('uses idb://app in browser environments', async () => {
    await act(async () => {
      renderHook(
        () => {
          const result = useFileRecordRepository();
          return result;
        },
        { wrapper }
      );
    });
    expect(PGlite).not.toHaveBeenCalled();
    expect(pgliteWorkerCreate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        dataDir: 'idb://app',
      })
    );
  });

  it('getDefaultDbPath respects runtime', () => {
    const originalWindow = globalThis.window;
    expect(getDefaultDbPath()).toBe('idb://app');
    // Temporarily set window to undefined to simulate Node.js environment
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    // In Node.js environment, it should point to the temp directory
    const nodePath = getDefaultDbPath();
    expect(nodePath).toBe(path.join(os.tmpdir(), 'app.db'));
    // Restore original window
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });
});
