import * as utilsModule from '@brainstrike/utils';
import { PGlite } from '@electric-sql/pglite';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

describe('DbProvider', () => {
  beforeEach(() => {
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });
  it('exposes FileRecordRepository via context', async () => {
    // Mock the wasmLoader to return a real PGlite instance without WASM loading
    const mockDb = new PGlite('memory://');
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

  it('runs migrations on mount and closes db on unmount in production', async () => {
    const mockDb = new PGlite('memory://');
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as undefined);
    const closeSpy = vi.spyOn(mockDb, 'close').mockResolvedValue(undefined as unknown as undefined);

    // Mock production environment
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);

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

    // Wait for the async close operation to complete
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    isDevEnvSpy.mockRestore();
  });

  it('keeps db open on unmount in development (Fast Refresh)', async () => {
    const mockDb = new PGlite('memory://');
    const createPGliteSpy = vi
      .spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as undefined);
    const closeSpy = vi.spyOn(mockDb, 'close').mockResolvedValue(undefined as unknown as undefined);

    // Mock development environment
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(true);

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

    // In development, the database should NOT be closed to avoid Fast Refresh issues
    expect(closeSpy).toHaveBeenCalledTimes(0);
    isDevEnvSpy.mockRestore();
  });

  it('waits for migrations before providing context', async () => {
    // Mock the database creation to succeed
    const mockDb = new PGlite('memory://');
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);

    // Mock the migration to be delayed
    let resolveMigration: () => void;
    const migratePromise = new Promise<void>((resolve) => {
      resolveMigration = resolve;
    });
    vi.spyOn(migrations, 'migrate').mockReturnValue(migratePromise);

    const { result } = renderHook(
      () => {
        const repo = useFileRecordRepository();
        return repo;
      },
      { wrapper }
    );
    expect(result.current).toBeNull();
    resolveMigration?.();
    await waitFor(() => expect(result.current).not.toBeNull(), {
      timeout: 10000, // 10 seconds timeout for CI
    });
  });

  it('returns null and logs error when initialization fails', async () => {
    const error = new Error('init failed');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Configure logger to enable logging in test environment
    const { configureLogger } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });

    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(error);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[DbProvider]',
        '[ERROR]',
        'Failed to initialize database:',
        error
      );
    });

    expect(result.current).toBeNull();
    consoleSpy.mockRestore();
  });

  it('logs an error if closing the db fails on unmount', async () => {
    const mockDb = new PGlite('memory://');
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as undefined);

    // Mock production environment but enable logging for the test
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);
    // Configure logger to enable logging in production for this test
    const { configureLogger } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });

    const closeError = new Error('close failed');
    const closeSpy = vi.spyOn(mockDb, 'close').mockRejectedValue(closeError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBeDefined(), { timeout: 10000 });

    expect(() => unmount()).not.toThrow();

    // Wait for the async close operation to complete
    await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[DbProvider]',
        '[ERROR]',
        'Failed to close database:',
        closeError
      );
    });
    consoleSpy.mockRestore();
    isDevEnvSpy.mockRestore();
  });
});
