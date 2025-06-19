import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { PGlite } from '@electric-sql/pglite';
import * as wasmLoaderModule from '../src/wasm-loader';
import * as migrations from '../src/migrations/bootstrap';
import * as utilsModule from '@brainstrike/utils';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
}

describe('DbProvider error handling', () => {
  const activeDatabases: PGlite[] = [];
  
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset logger configuration to defaults
    const { resetLogger } = require('@brainstrike/utils');
    resetLogger();
  });

  afterEach(async () => {
    // Clean up any active databases to prevent unhandled promise rejections
    await Promise.allSettled(
      activeDatabases.map(async (db) => {
        try {
          await db.close();
        } catch (error) {
          // Ignore close errors in cleanup
        }
      })
    );
    activeDatabases.length = 0;
    vi.restoreAllMocks();
  });

  it('handles database initialization errors gracefully', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Configure logger to enable logging in test environment
    const { configureLogger } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    const initError = new Error('Failed to initialize database');
    
    // Mock wasmLoader to throw an error
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(initError);

    const { result } = renderHook(() => {
      const ctx = useFileRecordRepository();
      // Access the context directly to check error state
      return ctx;
    }, { wrapper });

    // Wait for the error to be handled
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[DbProvider]', '[ERROR]', 'Failed to initialize and migrate database:', initError);
    });

    // The repository should be null when there's an error
    expect(result.current).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it('handles migration errors gracefully', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Configure logger to enable logging in test environment
    const { configureLogger } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    const migrationError = new Error('Migration failed');
    
    // Mock successful database creation but failed migration
    const mockDb = new PGlite(':memory:');
    activeDatabases.push(mockDb);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockRejectedValue(migrationError);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });

    // Wait for the error to be handled
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[DbProvider]', '[ERROR]', 'Failed to initialize and migrate database:', migrationError);
    });

    // The repository should be null when there's a migration error
    expect(result.current).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it('handles database close errors in production mode', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeError = new Error('Failed to close database');
    
    // Mock production environment but enable logging for the test
    const isDevEnvSpy = vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);
    // Configure logger to enable logging in production for this test
    const { configureLogger } = await import('@brainstrike/utils');
    configureLogger({ enableInProduction: true });
    
    // Create a mock database that fails to close
    const mockDb = new PGlite(':memory:');
    activeDatabases.push(mockDb);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as void);
    vi.spyOn(mockDb, 'close').mockRejectedValue(closeError);

    const { result, unmount } = renderHook(() => useFileRecordRepository(), { wrapper });

    // Wait for initialization
    await waitFor(() => expect(result.current).toBeDefined());

    // Unmount to trigger cleanup
    unmount();

    // Wait for the close error to be logged
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('[DbProvider]', '[ERROR]', 'Failed to close database:', closeError);
    });

    consoleErrorSpy.mockRestore();
    isDevEnvSpy.mockRestore();
  });

  it('prevents concurrent database initialization', async () => {
    let resolveDbCreation: (value: PGlite) => void;
    const dbCreationPromise = new Promise<PGlite>((resolve) => {
      resolveDbCreation = resolve;
    });

    // Mock a slow database creation
    const createPGliteSpy = vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockReturnValue(dbCreationPromise);
    
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as void);

    // Create a component that will trigger multiple effect runs
    let triggerRerender: () => void;
    function TestComponent() {
      const [, setCount] = React.useState(0);
      triggerRerender = () => setCount(c => c + 1);
      
      const repo = useFileRecordRepository();
      return <div>{repo ? 'ready' : 'loading'}</div>;
    }

    const { rerender } = renderHook(() => useFileRecordRepository(), {
      wrapper: ({ children }) => (
        <DbProvider dbPath=":memory:">
          <TestComponent />
          {children}
        </DbProvider>
      ),
    });

    // Trigger multiple rerenders while initialization is in progress
    triggerRerender!();
    triggerRerender!();
    rerender();

    // Verify createPGlite was only called once despite multiple renders
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);

    // Complete the initialization
    const mockDb = new PGlite(':memory:');
    activeDatabases.push(mockDb);
    resolveDbCreation!(mockDb);

    // Wait for initialization to complete
    await waitFor(() => {
      expect(createPGliteSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('handles already initialized database gracefully', async () => {
    const mockDb = new PGlite(':memory:');
    activeDatabases.push(mockDb);
    const createPGliteSpy = vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite')
      .mockResolvedValue(mockDb);
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined as unknown as void);

    // First render - initializes database
    const { result, rerender } = renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);

    // Force a re-render with the same wrapper - should not reinitialize
    rerender();
    
    // Verify database creation wasn't called again
    expect(createPGliteSpy).toHaveBeenCalledTimes(1);
  });
});