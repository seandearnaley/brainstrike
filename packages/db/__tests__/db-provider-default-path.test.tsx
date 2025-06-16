import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    delete (globalThis as any).window;
    // In Node.js environment, it should return a file path (either temp dir or fallback)
    const nodePath = getDefaultDbPath();
    expect(typeof nodePath).toBe('string');
    expect(nodePath.length).toBeGreaterThan(0);
    // Should be either a temp directory path or the fallback './app.db'
    expect(nodePath.endsWith('/') || nodePath === './app.db' || nodePath.includes('app.db')).toBe(true);
    globalThis.window = originalWindow;
  });
});
