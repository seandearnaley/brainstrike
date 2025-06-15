import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { PGlite } from '@electric-sql/pglite';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
}

describe('DbProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('exposes FileRecordRepository via context', async () => {
    // Mock the wasmLoader to return a real PGlite instance without WASM loading
    const mockDb = new PGlite(':memory:');
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    
    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined(), {
      timeout: 10000, // 10 seconds timeout for CI
    });
  });

  it('returns null when hook used outside provider', () => {
    const { result } = renderHook(() => useFileRecordRepository());
    expect(result.current).toBeNull();
  });

  it('runs migrations on mount and closes db on unmount', async () => {
    const mockDb = new PGlite(':memory:');
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as void);
    const closeSpy = vi
      .spyOn(mockDb, 'close')
      .mockResolvedValue(undefined as unknown as void);

    const { result, unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });

    await waitFor(() => expect(createPGliteSpy).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    await waitFor(() => expect(migrateSpy).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    await waitFor(() => expect(result.current).toBeDefined(), {
      timeout: 10000,
    });
    unmount();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('waits for migrations before providing context', async () => {
    let resolveMigration: () => void;
    const migratePromise = new Promise<void>((resolve) => {
      resolveMigration = resolve;
    });
    vi.spyOn(migrations, 'migrate').mockReturnValue(migratePromise);

    const { result } = renderHook(() => {
      try {
        return useFileRecordRepository();
      } catch {
        return null;
      }
    }, { wrapper });
    expect(result.current).toBeNull();
    resolveMigration!();
    await waitFor(() => expect(result.current).not.toBeNull(), {
      timeout: 10000, // 10 seconds timeout for CI
    });
  });
});
