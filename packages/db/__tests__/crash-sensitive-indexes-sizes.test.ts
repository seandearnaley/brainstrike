import { describe, expect, it } from 'vitest';
import { listCrashSensitiveIndexes } from '../src/crash-sensitive-indexes';

/** A handle that answers the catalog query with `row`, as PGlite would for `int8` columns. */
function handleReturning(row: Record<string, unknown>) {
  return {
    exec: async () => undefined,
    query: async <T>() => ({ rows: [row] as unknown as readonly T[] }),
  };
}

const IDENTITY = {
  accessMethod: 'bm25',
  index: 'idx_file_chunks_content_bm25',
  schema: 'public',
  table: 'file_chunks',
};

describe('listCrashSensitiveIndexes byte sizes', () => {
  it('returns every size as a number, whether the driver gave a number or a bigint', async () => {
    const [entry] = await listCrashSensitiveIndexes(
      handleReturning({ ...IDENTITY, heapBytes: 131n, indexBytes: 32, toastBytes: 211n })
    );

    expect(entry).toEqual({ ...IDENTITY, heapBytes: 131, indexBytes: 32, toastBytes: 211 });
    expect(typeof entry?.heapBytes).toBe('number');
  });

  it('throws, naming the index, for a size that is not a safe non-negative integer', async () => {
    await expect(
      listCrashSensitiveIndexes(
        handleReturning({ ...IDENTITY, heapBytes: 2n ** 60n, indexBytes: 0, toastBytes: 0 })
      )
    ).rejects.toThrow(/idx_file_chunks_content_bm25.*heapBytes/u);
  });
});
