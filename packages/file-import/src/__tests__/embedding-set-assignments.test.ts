import { describe, expect, it, vi } from 'vitest';
import { backfillEmbeddingSetAssignments } from '../embedding-set-assignments';

describe('backfillEmbeddingSetAssignments', () => {
  it('uses a single array parameter instead of expanding one placeholder per file id', async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await backfillEmbeddingSetAssignments({ query }, 'set-1', [
      'file-1',
      'file-2',
      'file-2',
      'file-3',
    ]);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE id::text = ANY($2::text[])'),
      ['set-1', ['file-1', 'file-2', 'file-3']]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE file_record_id::text = ANY($2::text[])'),
      ['set-1', ['file-1', 'file-2', 'file-3']]
    );
  });

  it('uses SQLite-compatible placeholder lists for Turso assignments', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const sql = { query, runtimeEngine: 'turso' as const };

    await backfillEmbeddingSetAssignments(sql, 'set-1', ['file-1', 'file-2', 'file-2']);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE id IN (?, ?)'), [
      'set-1',
      'file-1',
      'file-2',
      'set-1',
    ]);
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE file_record_id IN (?, ?)'),
      ['set-1', 'file-1', 'file-2']
    );
  });

  it('chunks Turso assignment backfills before exceeding the SQLite parameter budget', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const sql = { query, runtimeEngine: 'turso' as const };
    const fileIds = Array.from({ length: 899 }, (_, index) => `file-${index + 1}`);

    await backfillEmbeddingSetAssignments(sql, 'set-1', fileIds);

    expect(query).toHaveBeenCalledTimes(4);
    for (const [, params] of query.mock.calls) {
      expect(params?.length).toBeLessThanOrEqual(900);
    }
  });

  it('returns early when sql, collection id, or file ids are missing', async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await backfillEmbeddingSetAssignments(null, 'set-1', ['file-1']);
    await backfillEmbeddingSetAssignments({ query }, null, ['file-1']);
    await backfillEmbeddingSetAssignments({ query }, 'set-1', []);

    expect(query).not.toHaveBeenCalled();
  });
});
