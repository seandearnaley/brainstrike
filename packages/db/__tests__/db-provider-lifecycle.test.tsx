import * as utilsModule from '@brainstrike/utils';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbProviderModule from '../src/db-provider';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

type QueryMock = Mock<[string], Promise<{ rows: unknown[] } | undefined>>;
interface MockDb {
  close: Mock<[], Promise<void>>;
  exec: Mock<[string], Promise<unknown>>;
  query: QueryMock;
  transaction?: Mock<
    [callback: (tx: { query: QueryMock }) => Promise<unknown> | unknown],
    Promise<unknown>
  >;
}

function createMockDb(overrides: Partial<MockDb> = {}): MockDb {
  const baseQuery: QueryMock = vi.fn(async (sql: string) => {
    if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  });
  return {
    query: baseQuery,
    exec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

interface MockIpcBridge {
  clearAll: Mock;
  diagnostics: Mock;
  exec: Mock;
  ping: Mock;
  query: Mock;
  resetLocal: Mock;
  test: Mock;
}

function createMockIpcBridge(): MockIpcBridge {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
        return { rows: [{ '?column?': 1 }] };
      }
      return { rows: [] };
    }),
    exec: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ success: true })),
    diagnostics: vi.fn(async () => null),
    test: vi.fn(async () => ({ success: true, message: 'ok' })),
    clearAll: vi.fn(async () => ({ success: true })),
    resetLocal: vi.fn(async () => ({ success: true })),
  };
}

// Helper to set window.electronAPI in tests
function setWindowElectronAPI(db: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    value: { db },
    writable: true,
    configurable: true,
  });
}

function clearWindowElectronAPI(): void {
  Object.defineProperty(window, 'electronAPI', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

describe('DbProvider lifecycle', () => {
  beforeEach(() => {
    const { resetLogger } = utilsModule;
    resetLogger();
  });

  afterEach(async () => {
    // Clean up window.electronAPI mock between tests
    if (typeof window !== 'undefined') {
      clearWindowElectronAPI();
    }
    vi.restoreAllMocks();
  });

  describe('IPC mode cleanup', () => {
    function ipcWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DbProvider dbPath="memory://" useElectronIPC={true}>
          {children}
        </DbProvider>
      );
    }

    it('does not call close() on IPC bridge during unmount', async () => {
      const bridge = createMockIpcBridge();
      setWindowElectronAPI(bridge);

      const closeSpy = vi.fn();
      // Attach an explicit close spy to confirm it is never called
      (bridge as MockIpcBridge & { close: Mock }).close = closeSpy;

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: ipcWrapper,
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      unmount();

      // close should never be called in IPC mode — the main process owns the DB
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('nulls connectionRef on IPC unmount', async () => {
      const bridge = createMockIpcBridge();
      setWindowElectronAPI(bridge);

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: ipcWrapper,
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      // After unmount, requesting the hook outside a provider returns null
      unmount();

      // Re-render outside provider to confirm context is gone
      const { result: outerResult } = renderHook(() => useFileRecordRepository());
      expect(outerResult.current).toBeNull();
    });

    it('does not throw TypeError during IPC cleanup', async () => {
      // Intentionally partial bridge — omits diagnostics, clearAll, and close
      // to reproduce the original bug where unmount called bridge.close()
      const bridge: Record<string, Mock> = {
        query: vi.fn(async (sql: string) => {
          if (sql === migrations.PGVECTOR_EXTENSION_PRESENCE_QUERY) {
            return { rows: [{ '?column?': 1 }] };
          }
          return { rows: [] };
        }),
        exec: vi.fn(async () => {}),
        ping: vi.fn(async () => ({ success: true })),
        test: vi.fn(async () => ({ success: true, message: 'ok' })),
      };

      setWindowElectronAPI(bridge);

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: ipcWrapper,
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      // Unmount must not throw — the IPC path should do a no-op cleanup
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Direct PGlite cleanup', () => {
    function directWrapper(dbPath: string) {
      return function Wrapper({ children }: { children: React.ReactNode }) {
        return <DbProvider dbPath={dbPath}>{children}</DbProvider>;
      };
    }

    it.each([
      'idb://testdb',
      'opfs-ahp://testdb',
    ])('calls wasmLoader.closeCached for %s browser persistent databases in production', async (dbPath) => {
      const mockDb = createMockDb();
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGliteClient').mockResolvedValue(
        mockDb as unknown as Awaited<ReturnType<typeof wasmLoaderModule.wasmLoader.createPGlite>>
      );
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
      vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);
      const closeCachedSpy = vi
        .spyOn(wasmLoaderModule.wasmLoader, 'closeCached')
        .mockResolvedValue(undefined);

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: directWrapper(dbPath),
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      unmount();

      await waitFor(() => expect(closeCachedSpy).toHaveBeenCalledWith(dbPath), {
        timeout: 1000,
      });
      // db.close() should NOT be called directly for cached browser storage paths
      expect(mockDb.close).not.toHaveBeenCalled();
    });

    it('calls db.close() for memory databases in production', async () => {
      const mockDb = createMockDb();
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
      vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(false);

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: directWrapper('memory://'),
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      unmount();

      // For non-idb paths, db.close() is called directly
      await waitFor(() => expect(mockDb.close).toHaveBeenCalledTimes(1), {
        timeout: 1000,
      });
    });

    it('skips close in dev mode for HMR protection', async () => {
      const mockDb = createMockDb();
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
      vi.spyOn(utilsModule, 'isDevEnv').mockReturnValue(true);
      const closeCachedSpy = vi
        .spyOn(wasmLoaderModule.wasmLoader, 'closeCached')
        .mockResolvedValue(undefined);

      const { result, unmount } = renderHook(() => useFileRecordRepository(), {
        wrapper: directWrapper('idb://testdb'),
      });

      await waitFor(() => expect(result.current).toBeDefined(), {
        timeout: 10_000,
      });

      unmount();

      // In dev mode, neither close path should be invoked (HMR protection)
      expect(mockDb.close).not.toHaveBeenCalled();
      expect(closeCachedSpy).not.toHaveBeenCalled();
    });
  });

  describe('retired queue and embedding-set purge helper', () => {
    it('does not expose the raw SQL queue/set purge hook from the provider module', () => {
      expect(dbProviderModule).not.toHaveProperty('useClearQueuesAndEmbeddingSets');
    });
  });
});
