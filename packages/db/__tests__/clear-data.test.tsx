// @vitest-environment jsdom
import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import { useClearAllData, useFileRecordRepository } from '../src/use-db';
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
    close: vi.fn(async () => {}),
    exec: vi.fn(async () => {}),
    query: baseQuery,
    ...overrides,
  };
}

/**
 * Dispatch-by-SQL `tx.query` stub for the probe-first clear path.
 *
 * Every optional relation is now PROBED with `to_regclass` before its DELETE, so
 * a positional `mockResolvedValueOnce` chain has to be re-counted every time a
 * table joins the clear — which is exactly how these tests used to break. Match
 * on the statement instead: `absent` makes a probe answer "not present" and
 * `onDelete` may throw to simulate a genuine delete failure.
 */
function createClearQueryMock({
  absent = [],
  counts = {},
  onDelete,
}: {
  absent?: readonly string[];
  counts?: Record<string, string>;
  onDelete?: (table: string) => void;
} = {}): QueryMock {
  const missing = new Set<string>(absent);
  return vi.fn(async (sql: string) => {
    const counted = sql.match(/^SELECT COUNT\(\*\) as count FROM (\w+)$/u);
    if (counted) {
      return { rows: [{ count: counts[counted[1] as string] ?? '0' }] };
    }
    const probed = sql.match(/^SELECT to_regclass\('([^']+)'\)/u);
    if (probed) {
      return { rows: [{ present: !missing.has(probed[1] as string) }] };
    }
    const deleted = sql.match(/^DELETE FROM (\w+)$/u);
    if (deleted) {
      onDelete?.(deleted[1] as string);
    }
    return { rows: [] };
  });
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
          return { clearData, repo };
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
        deletedChunks: 0,
        deletedFiles: 0,
      });
      expect(mockTransaction).toHaveBeenCalled();
    });

    it('should successfully clear database with data', async () => {
      const queryMock = createClearQueryMock({
        counts: { file_chunks: '10', file_records: '5' },
      });
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
          return { clearData, repo };
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
        deletedChunks: 10,
        deletedFiles: 5,
      });
      // Factory-reset contract: stale roots must not survive a clear and
      // resurface as ghost workspaces once consumers read the roots table.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM roots');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM prompt_items');
      // BST-558: suspended workflow snapshots have an unbounded lifetime (no
      // production delete path), so the clear/reset must purge them or a
      // pending approval's tool arguments survive a "true fresh start".
      // The OTHER reset path (`purgeTablesTx`) is locked in
      // factory-reset.test.tsx; real transaction semantics — which a mocked
      // `tx.query` structurally cannot model — in clear-data.integration.test.tsx.
      expect(queryMock).toHaveBeenCalledWith(`DELETE FROM ${MASTRA_WORKFLOW_TABLE}`);
      // BST-992: FK-less assistant stores that desktop `db:clearAll` cleared
      // but the web paths silently missed — token/cost history and branch
      // topology must not survive a web Clear Database.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_run_usage');
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM brainstrike_assistant_message_parents');
      // BST-992 convergence boundary: the factory-reset-only caches are NOT
      // cleared by Clear Database on any surface (desktop db:clearAll never
      // cleared them either — the 27-relation clear-set parity holds).
      expect(queryMock).not.toHaveBeenCalledWith('DELETE FROM token_cache');
      expect(queryMock).not.toHaveBeenCalledWith('DELETE FROM embedding_cache');
    });

    it('propagates a real prompt_items delete failure from direct clear', async () => {
      const queryMock = createClearQueryMock({
        onDelete: (table) => {
          if (table === 'prompt_items') {
            throw new Error('prompt storage I/O failure');
          }
        },
      });
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => ({
          clearData: useClearAllData(),
          repo: useFileRecordRepository(),
        }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.clearData).not.toBeNull();
      });

      await expect(result.current.clearData?.()).rejects.toThrow('prompt storage I/O failure');
    });

    // Absence is tolerated by SKIPPING the delete, not by catching its 42P01:
    // inside a transaction the caught error has already aborted everything, so
    // delete-and-tolerate rolled the whole clear back (BST-558).
    it('skips prompt_items during direct clear when the relation is absent', async () => {
      const queryMock = createClearQueryMock({ absent: ['prompt_items'] });
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => ({
          clearData: useClearAllData(),
          repo: useFileRecordRepository(),
        }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.clearData).not.toBeNull();
      });

      await expect(result.current.clearData?.()).resolves.toEqual({
        deletedChunks: 0,
        deletedFiles: 0,
      });
      expect(queryMock).not.toHaveBeenCalledWith('DELETE FROM prompt_items');
      // The clear must continue past the absent relation, not abandon it.
      expect(queryMock).toHaveBeenCalledWith('DELETE FROM roots');
    });

    /**
     * A 42P01 naming a DIFFERENT relation (a trigger's audit table) must not be
     * mistaken for "prompt_items is absent". Under probe-first that holds by
     * construction: the probe already said the table is present, so the DELETE is
     * unwrapped and the real error propagates verbatim.
     */
    it('propagates an undefined-table error for a different relation during prompt cleanup', async () => {
      const triggerFailure = Object.assign(
        new Error('relation "prompt_item_audit_log" does not exist while deleting prompt_items'),
        { code: '42P01' }
      );
      const queryMock = createClearQueryMock({
        onDelete: (table) => {
          if (table === 'prompt_items') {
            throw triggerFailure;
          }
        },
      });
      const mockTransaction: TransactionMock = vi.fn(
        async (callback: TransactionCallback) => await callback({ query: queryMock })
      );
      const mockDb = createMockDb({ transaction: mockTransaction as MockDb['transaction'] });
      activeDatabases.push(mockDb);

      vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
      vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);

      const { result } = renderHook(
        () => ({
          clearData: useClearAllData(),
          repo: useFileRecordRepository(),
        }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.repo).not.toBeNull();
        expect(result.current.clearData).not.toBeNull();
      });

      await expect(result.current.clearData?.()).rejects.toThrow('prompt_item_audit_log');
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
          return { clearData, repo };
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
          return { clearData, repo };
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
