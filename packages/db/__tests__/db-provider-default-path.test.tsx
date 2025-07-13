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
    // biome-ignore lint/suspicious/noExplicitAny: Mock object requires any for testing
    const calls = (PGlite as any).mock.calls;
    // biome-ignore lint/suspicious/noExplicitAny: Mock call signature requires any for testing
    expect(calls.some((call: any[]) => call[0] === 'idb://app')).toBe(true);
  });

  it('getDefaultDbPath respects runtime', () => {
    const originalWindow = globalThis.window;
    expect(getDefaultDbPath()).toBe('idb://app');
    (globalThis as typeof globalThis & { window?: Window }).window = undefined;
    // In Node.js environment, it should point to the temp directory
    const nodePath = getDefaultDbPath();
    expect(nodePath).toBe(path.join(os.tmpdir(), 'app.db'));
    globalThis.window = originalWindow;
  });
});
