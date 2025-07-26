import { PGlite } from '@electric-sql/pglite';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useClearAllData, useFileRecordRepository } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
}

describe('Database clearing functionality', () => {
  const activeDatabases: PGlite[] = [];

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
      const mockDb = new PGlite(':memory:');
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(() => useClearAllData(), { wrapper });

      await waitFor(() => {
        expect(result.current).not.toBeNull();
      });
    });

    it('should successfully clear empty database', async () => {
      const mockDb = new PGlite(':memory:');
      activeDatabases.push(mockDb);

      // Mock successful database operations
      const mockTransaction = vi.fn().mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // chunks count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // files count
            .mockResolvedValueOnce(undefined), // DELETE files
        };
        return await callback(mockTx);
      });

      mockDb.transaction = mockTransaction;

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
      if (!clearResult) throw new Error('Clear function returned undefined');

      expect(clearResult).toEqual({
        deletedFiles: 0,
        deletedChunks: 0,
      });
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should successfully clear database with data', async () => {
      const mockDb = new PGlite(':memory:');
      activeDatabases.push(mockDb);

      const mockTransaction = vi.fn().mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // chunks count
            .mockResolvedValueOnce(undefined) // DELETE chunks
            .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // files count
            .mockResolvedValueOnce(undefined), // DELETE files
        };
        return await callback(mockTx);
      });

      mockDb.transaction = mockTransaction;

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
      if (!clearResult) throw new Error('Clear function returned undefined');

      expect(clearResult).toEqual({
        deletedFiles: 5,
        deletedChunks: 10,
      });
    });

    it('should handle transaction errors gracefully', async () => {
      const mockDb = new PGlite(':memory:');
      activeDatabases.push(mockDb);

      const mockTransaction = vi.fn().mockRejectedValue(new Error('Transaction failed'));
      mockDb.transaction = mockTransaction;

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

      if (!result.current.clearData) throw new Error('Clear function is null');
      await expect(result.current.clearData()).rejects.toThrow('Transaction failed');
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
      const mockDb = new PGlite(':memory:');
      activeDatabases.push(mockDb);

      const mockTransaction = vi.fn().mockImplementation(async (callback) => {
        const mockTx = {
          query: vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // chunks count
            .mockRejectedValueOnce(new Error('Delete chunks failed')), // DELETE chunks fails
        };
        return await callback(mockTx);
      });

      mockDb.transaction = mockTransaction;

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
      if (!result.current.clearData) throw new Error('Clear function is null');
      await expect(result.current.clearData()).rejects.toThrow('Delete chunks failed');
      expect(mockTransaction).toHaveBeenCalled();
    });
  });

  describe('Integration with repositories', () => {
    it('should work with file record repository', async () => {
      const mockDb = new PGlite(':memory:');
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

      await waitFor(() => {
        expect(result.current.clearAllData).not.toBeNull();
        expect(result.current.fileRepository).not.toBeNull();
      });

      // Both should be available when database is ready
      expect(result.current.clearAllData).not.toBeNull();
      expect(result.current.fileRepository).not.toBeNull();
    });
  });
});
