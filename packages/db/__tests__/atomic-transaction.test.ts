import { describe, expect, it, vi } from 'vitest';
import { type AtomicStatementTransport, runAtomicStatements } from '../src/atomic-transaction.js';

const STATEMENTS = [
  { sql: "SET LOCAL hnsw.ef_search = '120'" },
  { params: ['thread-1'], sql: 'SELECT id FROM thread_search_index WHERE thread_id = $1' },
];

describe('runAtomicStatements', () => {
  it('uses the IPC statement-list capability as one atomic operation', async () => {
    const runTransaction = vi.fn().mockResolvedValue({ rows: [{ id: 'message-1' }] });
    const transaction = vi.fn();

    await expect(
      runAtomicStatements({ runTransaction, transaction }, STATEMENTS, 1, 'missing capability')
    ).resolves.toEqual({ rows: [{ id: 'message-1' }] });

    expect(runTransaction).toHaveBeenCalledWith(STATEMENTS, 1);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('propagates IPC statement-list transaction failures', async () => {
    const failure = new Error('IPC transaction failed');
    const runTransaction = vi.fn().mockRejectedValue(failure);

    await expect(
      runAtomicStatements({ runTransaction }, STATEMENTS, 1, 'missing capability')
    ).rejects.toBe(failure);
  });

  it('runs SET LOCAL and SELECT through one callback transaction', async () => {
    const calls: Array<{ params?: unknown[]; sql: string }> = [];
    const transaction = vi.fn(
      async <T>(
        operation: (tx: {
          query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        }) => Promise<T>
      ): Promise<T> =>
        await operation({
          query: async (sql: string, params?: unknown[]) => {
            calls.push({ params, sql });
            return { rows: sql.startsWith('SELECT') ? [{ id: 'message-1' }] : [] };
          },
        })
    );

    await expect(
      runAtomicStatements({ transaction }, STATEMENTS, 1, 'missing capability')
    ).resolves.toEqual({ rows: [{ id: 'message-1' }] });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(STATEMENTS);
  });

  it('returns only rows from the designated callback statement', async () => {
    const transaction = async <T>(
      operation: (tx: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      }) => Promise<T>
    ): Promise<T> =>
      await operation({
        query: async () => ({
          affectedRows: 7,
          rows: [{ id: 'message-1' }],
        }),
      });

    await expect(
      runAtomicStatements({ transaction }, STATEMENTS, 1, 'missing capability')
    ).resolves.toEqual({ rows: [{ id: 'message-1' }] });
  });

  it('propagates callback transaction statement failures', async () => {
    const failure = new Error('vector SELECT failed');
    const transaction = vi.fn(
      async <T>(
        operation: (tx: {
          query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        }) => Promise<T>
      ): Promise<T> =>
        await operation({
          query: async (sql: string) => {
            if (sql.startsWith('SELECT')) {
              throw failure;
            }
            return { rows: [] };
          },
        })
    );

    await expect(
      runAtomicStatements({ transaction }, STATEMENTS, 1, 'missing capability')
    ).rejects.toBe(failure);
  });

  it('rejects a query-only handle without issuing any statement', async () => {
    const query = vi.fn();
    const transport: AtomicStatementTransport & { query: typeof query } = { query };

    await expect(
      runAtomicStatements(transport, STATEMENTS, 1, 'Thread search requires atomic transactions.')
    ).rejects.toThrow('Thread search requires atomic transactions.');
    expect(query).not.toHaveBeenCalled();
  });

  it('validates the statement list before invoking either atomic transport', async () => {
    const runTransaction = vi.fn();

    await expect(
      runAtomicStatements({ runTransaction }, [], 0, 'missing capability')
    ).rejects.toThrow('at least one statement');
    await expect(
      runAtomicStatements({ runTransaction }, [{ sql: 'SELECT 1' }], 1, 'missing capability')
    ).rejects.toThrow('resultIndex');
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
