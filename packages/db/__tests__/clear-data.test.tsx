import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useClearAllData, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

type QueryMock = Mock<[string], Promise<{ rows: unknown[] } | undefined>>;
type TransactionCallback = (tx: { query: QueryMock }) => Promise<unknown> | unknown;
type TransactionMock = Mock<[callback: TransactionCallback], Promise<unknown>>;

interface MockDb {
  close: Mock<[], Promise<void>>;
  closed?: boolean;
  exec: Mock<[string], Promise<unknown>>;
  query: QueryMock;
  transaction?: TransactionMock;
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

describe('Database clearing functionality', () => {
  const activeDatabases: MockDb[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any active databases
    await Promise.allSettled(
      activeDatabases.map(async (db) => {
        try {
          if (!db.closed) {
            await db.close();
          }
        } catch {
          // Ignore cleanup errors
        }
      })
    );
    activeDatabases.length = 0;
  });

  describe('useClearAllData hook', () => {
    it('should be available when repositories are ready', async () => {
      // Mock successful initialization
      const mockDb = createMockDb();
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(() => useClearAllData(), { wrapper });

      await waitFor(() => {
        expect(result.current).not.toBeNull();
      });
    });

    it('should successfully clear empty database', async () => {
      const mockTransaction: TransactionMock = vi.fn(async (callback: TransactionCallback) => {
        const mockTx = {
          query: vi
            .fn<[string], Promise<{ rows: unknown[] } | undefined>>(async () => ({ rows: [] }))
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined), // DELETE files
        };
        return await callback(mockTx);
      });
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository(); // Trigger lazy initialization
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      // Wait for the database to be initialized
      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      const clearResult = await result.current.clearData?.();
      if (!clearResult) {
        throw new Error('Clear function returned undefined');
      }

      expect(clearResult).toEqual({
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should successfully clear database with data', async () => {
      const queryMock = vi.fn<[string], Promise<{ rows: unknown[] } | undefined>>(
        async (sql: string) => {
          if (sql === 'SELECT COUNT(*) as count FROM file_chunks') {
            return { rows: [{ count: '10' }] };
          }
          if (sql === 'SELECT COUNT(*) as count FROM file_records') {
            return { rows: [{ count: '5' }] };
          }
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          return { rows: [] };
        }
      );
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository(); // Trigger lazy initialization
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      // Wait for the database to be initialized
      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      const clearResult = await result.current.clearData?.();
      if (!clearResult) {
        throw new Error('Clear function returned undefined');
      }

      expect(clearResult).toEqual({
        deletedFiles: 5,
        deletedChunks: 10,
      });
      // Factory-reset contract: stale roots must not survive a clear and
      // resurface as ghost workspaces once consumers read the roots table.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM roots');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_run_usage');
    });

    it('should handle transaction errors gracefully', async () => {
      const mockTransaction: TransactionMock = vi.fn(async () => {
        throw new Error('Transaction failed');
      });
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository(); // Trigger lazy initialization
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      // Wait for the database to be initialized
      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      if (!result.current.clearData) {
        throw new Error('Clear function is null');
      }
      await expect(result.current.clearData()).rejects.toThrow('Transaction failed');
    });

    it('skips assistant run usage purge when the legacy table is absent', async () => {
      const queryMock = vi.fn<[string], Promise<{ rows: unknown[] } | undefined>>(
        async (sql: string) => {
          if (sql === 'SELECT COUNT(*) as count FROM file_chunks') {
            return { rows: [{ count: '0' }] };
          }
          if (sql === 'SELECT COUNT(*) as count FROM file_records') {
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: false }] };
          }
          return { rows: [] };
        }
      );
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository();
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      await expect(result.current.clearData?.()).resolves.toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
      });
      expect(queryMock).not.toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_run_usage');
    });

    it('fails when assistant run usage cannot be purged', async () => {
      const queryMock = vi.fn<[string], Promise<{ rows: unknown[] } | undefined>>(
        async (sql: string) => {
          if (sql === 'SELECT COUNT(*) as count FROM file_chunks') {
            return { rows: [{ count: '0' }] };
          }
          if (sql === 'SELECT COUNT(*) as count FROM file_records') {
            return { rows: [{ count: '0' }] };
          }
          if (sql.includes('information_schema.tables')) {
            return { rows: [{ exists: true }] };
          }
          if (sql === 'DELETE FROM brainstrike_assistant_run_usage') {
            throw new Error('assistant usage purge failed');
          }
          return { rows: [] };
        }
      );
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository();
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      if (!result.current.clearData) {
        throw new Error('Clear function is null');
      }
      await expect(result.current.clearData()).rejects.toThrow('assistant usage purge failed');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_run_usage');
    });

    it('should throw error when repositories are not available', async () => {
      // Don't mock the database initialization to simulate unavailable repositories
      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockRejectedValue(
        new Error('DB init failed')
      );

      const { result } = renderHook(() => useClearAllData(), { wrapper });

      await waitFor(() => {
        expect(result.current).toBeNull();
      });

      // Since result.current is null, we can't call it - the hook should return null when DB isn't ready
      expect(result.current).toBeNull();
    });

    it('should ensure atomic operation - all or nothing', async () => {
      const mockTransaction: TransactionMock = vi.fn(async (callback: TransactionCallback) => {
        const mockTx = {
          query: vi
            .fn<[string], Promise<{ rows: unknown[] } | undefined>>(async () => ({ rows: [] }))
            .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // chunks count
            .mockRejectedValueOnce(new Error('Delete chunks failed')), // DELETE chunks fails
        };
        return await callback(mockTx);
      });
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => {
          const repo = useFileRecordRepository(); // Trigger lazy initialization
          const clearData = useClearAllData();
          return { repo, clearData };
        },
        { wrapper }
      );

      // Wait for the database to be initialized
      await waitFor(
        () => {
          expect(result.current.repo).not.toBeNull();
          expect(result.current.clearData).not.toBeNull();
        },
        { timeout: 5000 }
      );

      // Should fail and not partially clear data
      if (!result.current.clearData) {
        throw new Error('Clear function is null');
      }
      await expect(result.current.clearData()).rejects.toThrow('Delete chunks failed');
      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe('Integration with repositories', () => {
    it('should work with file record repository', async () => {
      const mockDb = createMockDb();
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => ({
          clearAllData: useClearAllData(),
          fileRepository: useFileRecordRepository(),
        }),
        { wrapper }
      );

      await waitFor(
        () => {
          expect(result.current.clearAllData).not.toBeNull();
          expect(result.current.fileRepository).not.toBeNull();
        },
        { timeout: 5000 }
      );

      // Both should be available when database is ready
      expect(result.current.clearAllData).not.toBeNull();
      expect(result.current.fileRepository).not.toBeNull();
    });
  });
});
