import { describe, expect, it, vi } from 'vitest';
import {
  applyManagedCacheBatch,
  type ManagedCacheBatchMutation,
} from '../src/managed-cache/apply-managed-cache-batch.js';
import type { IDatabase } from '../src/repositories/interfaces.js';

function replacements(count: number): ManagedCacheBatchMutation[] {
  return Array.from({ length: count }, (_, index) => ({
    mode: 'replace',
    record: {
      content: 'content',
      contentHash: `hash-${index}`,
      id: `record-${index}`,
      mtimeMs: null,
      name: `file-${index}.ts`,
      path: `src/file-${index}.ts`,
      processedAt: '2026-09-12T00:00:00.000Z',
      size: 7,
      tokenCount: 1,
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
  }));
}

describe('managed-cache replacement parameter admission', () => {
  it('builds the largest supported replacement statement including the embedding-set bind', async () => {
    const statementBuilt = new Error('Replacement statement captured');
    const captureStatement = vi.fn<(sql: string, params: unknown[] | undefined) => void>();
    const db: IDatabase = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (sql.startsWith('UPDATE file_records')) {
          captureStatement(sql, params);
          throw statementBuilt;
        }
        return { rows: [] };
      },
      transaction: async (callback) => callback(db),
    };

    await expect(
      applyManagedCacheBatch(db, {
        changes: replacements(6553),
        embeddingSetId: 'set-1',
      })
    ).rejects.toBe(statementBuilt);

    expect(captureStatement).toHaveBeenCalledOnce();
    const call = captureStatement.mock.calls[0];
    if (!call) {
      throw new Error('Expected a captured replacement statement');
    }
    const [sql, params] = call;
    expect(params).toHaveLength(65_531);
    expect(params?.at(-1)).toBe('set-1');
    expect(sql).toMatch(/embedding_set_id\s*=\s*\$65531/);
    const placeholderIndices = new Set(
      [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    );
    expect(placeholderIndices.size).toBe(65_531);
    expect([...placeholderIndices].find((index) => index < 1 || index > 65_531)).toBeUndefined();
  });

  it('rejects the next replacement row before opening a transaction or issuing SQL', async () => {
    const queryCalls = vi.fn<() => void>();
    const transactionCalls = vi.fn<() => void>();
    const db: IDatabase = {
      query: async () => {
        queryCalls();
        throw new Error('Oversized batch reached SQL');
      },
      transaction: async () => {
        transactionCalls();
        throw new Error('Oversized batch opened a transaction');
      },
    };
    await expect(
      applyManagedCacheBatch(db, {
        changes: replacements(6554),
        embeddingSetId: 'set-1',
      })
    ).rejects.toThrow('Managed cache batch replace exceeds the PostgreSQL parameter limit.');
    expect(transactionCalls).not.toHaveBeenCalled();
    expect(queryCalls).not.toHaveBeenCalled();
  });
});
