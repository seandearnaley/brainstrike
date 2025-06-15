import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@electric-sql/pglite', () => {
  return {
    PGlite: vi.fn(() => ({
      query: vi.fn(),
      exec: vi.fn(),
      close: vi.fn(),
    })),
  };
});

vi.mock('../src/migrations/bootstrap', () => ({
  migrate: vi.fn().mockResolvedValue(undefined),
}));

import {
  DbProvider,
  useFileRecordRepository,
  getDefaultDbPath,
} from '../src/db-provider';
import { PGlite } from '@electric-sql/pglite';

function wrapper({ children }: { children: React.ReactNode; }) {
  return <DbProvider>{children}</DbProvider>;
}

describe('DbProvider default dbPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses idb://app in browser environments', async () => {
    await act(async () => {
      renderHook(() => {
        try {
          return useFileRecordRepository();
        } catch {
          return null;
        }
      }, { wrapper });
    });
    expect(PGlite).toHaveBeenCalledWith('idb://app');
  });

  it('getDefaultDbPath respects runtime', () => {
    const originalWindow = globalThis.window;
    expect(getDefaultDbPath()).toBe('idb://app');
    // @ts-expect-error - delete window to simulate non-browser
    delete (globalThis as any).window;
    expect(getDefaultDbPath()).toBe('app.db');
    globalThis.window = originalWindow;
  });
});
