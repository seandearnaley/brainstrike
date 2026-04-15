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

  it('returns early when sql, collection id, or file ids are missing', async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await backfillEmbeddingSetAssignments(null, 'set-1', ['file-1']);
    await backfillEmbeddingSetAssignments({ query }, null, ['file-1']);
    await backfillEmbeddingSetAssignments({ query }, 'set-1', []);

    expect(query).not.toHaveBeenCalled();
  });
});
