import os from 'node:os';
import path from 'node:path';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@electric-sql/pglite', () => {
  return {
    PGlite: vi.fn(() => ({
      query: vi.fn(),
      exec: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

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
    // Check that PGlite was called with the expected path
    // The second call should be the actual DbProvider usage, the first might be from WasmLoader
    const calls = (PGlite as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      calls.some((call) => {
        if (!Array.isArray(call)) return false;
        const arg = call?.[0];
        if (typeof arg === 'string') {
          return arg === 'idb://app';
        }
        if (typeof arg === 'object' && arg !== null && 'dataDir' in arg) {
          return (arg as { dataDir?: unknown }).dataDir === 'idb://app';
        }
        return false;
      })
    ).toBe(true);
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
