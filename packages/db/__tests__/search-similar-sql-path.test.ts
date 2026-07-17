import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import {
  EXACT_FILTERED_SCAN_MAX_RATIO,
  EXACT_FILTERED_SCAN_MAX_ROWS,
  resolveFilteredVectorSearchRoute,
} from '../src/repositories/_shared.js';
import type {
  FileChunkDatabase,
  FileChunkQueryTx,
} from '../src/repositories/file-chunk-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('searchSimilar SQL path guards', () => {
  it('requires embeddingSetId when vectorEnabled', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://sql-guard');
    await migrate(db);
    const repo = new FileChunkRepository(db);
    await expect(repo.searchSimilar([0.1, 0.2, 0.3], { limit: 5 })).rejects.toThrowError(
      /requires embeddingSetId/
    );
  });
});

describe('fullTextSearch SQL path guards', () => {
  function createRepository(): {
    query: ReturnType<typeof vi.fn>;
    repo: FileChunkRepository;
  } {
    const query = vi.fn();
    const queryTx: FileChunkQueryTx = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        query(sql, params);
        return { rows: [] as T[] };
      },
    };
    const db: FileChunkDatabase = {
      ...queryTx,
      transaction: async <T>(fn: (tx: FileChunkQueryTx) => Promise<T>) => fn(queryTx),
    };
    return { query, repo: new FileChunkRepository(db) };
  }

  it('binds the validated rank-normalization bitmask instead of interpolating it', async () => {
    const { query, repo } = createRepository();

    await repo.fullTextSearch('needle', {
      includeHeadline: false,
      rankNormalization: 1 | 2,
    });

    const [searchSql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(searchSql.match(/\$3::integer/g)).toHaveLength(2);
    expect(searchSql).not.toContain('DROP TABLE');
    expect(params).toEqual(['english', 'needle', 3, 10]);
  });

  it('rejects malformed runtime values before issuing SQL', async () => {
    const { query, repo } = createRepository();

    await expect(
      repo.fullTextSearch('needle', {
        rankNormalization: '0); DROP TABLE file_chunks; --' as unknown as number,
      })
    ).rejects.toThrow('Expected an integer bitmask from 0 to 63');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('resolveFilteredVectorSearchRoute (selective-filter routing)', () => {
  it('routes an empty filter match to "empty" without counting the set total', async () => {
    const countMatched = vi.fn().mockResolvedValue(0);
    const countSetTotal = vi.fn();
    await expect(resolveFilteredVectorSearchRoute(countMatched, countSetTotal)).resolves.toBe(
      'empty'
    );
    expect(countMatched).toHaveBeenCalledWith(EXACT_FILTERED_SCAN_MAX_ROWS + 1);
    expect(countSetTotal).not.toHaveBeenCalled();
  });

  it('routes an oversized filter match to "ann" without counting the set total', async () => {
    const countMatched = vi.fn().mockResolvedValue(EXACT_FILTERED_SCAN_MAX_ROWS + 1);
    const countSetTotal = vi.fn();
    await expect(resolveFilteredVectorSearchRoute(countMatched, countSetTotal)).resolves.toBe(
      'ann'
    );
    expect(countSetTotal).not.toHaveBeenCalled();
  });

  it('routes to "exact" when the bounded set total proves the ratio is selective', async () => {
    // matched=10 -> total cap = ceil(10 / 0.15) = 67; a bounded count reaching
    // the cap proves matched/total <= maxRatio.
    const expectedCap = Math.ceil(10 / EXACT_FILTERED_SCAN_MAX_RATIO);
    const countMatched = vi.fn().mockResolvedValue(10);
    const countSetTotal = vi.fn().mockResolvedValue(expectedCap);
    await expect(resolveFilteredVectorSearchRoute(countMatched, countSetTotal)).resolves.toBe(
      'exact'
    );
    expect(countSetTotal).toHaveBeenCalledWith(expectedCap);
  });

  it('routes to "ann" when the filter covers most of the set (ratio not selective)', async () => {
    const expectedCap = Math.ceil(10 / EXACT_FILTERED_SCAN_MAX_RATIO);
    const countMatched = vi.fn().mockResolvedValue(10);
    const countSetTotal = vi.fn().mockResolvedValue(expectedCap - 1);
    await expect(resolveFilteredVectorSearchRoute(countMatched, countSetTotal)).resolves.toBe(
      'ann'
    );
  });

  it('honors caller-provided maxRows and maxRatio', async () => {
    const countMatched = vi.fn().mockResolvedValue(5);
    const countSetTotal = vi.fn().mockResolvedValue(10);
    await expect(
      resolveFilteredVectorSearchRoute(countMatched, countSetTotal, {
        maxRatio: 0.5,
        maxRows: 4,
      })
    ).resolves.toBe('ann'); // matched 5 > maxRows 4
    expect(countMatched).toHaveBeenCalledWith(5);

    countMatched.mockResolvedValue(4);
    await expect(
      resolveFilteredVectorSearchRoute(countMatched, countSetTotal, {
        maxRatio: 0.5,
        maxRows: 4,
      })
    ).resolves.toBe('exact'); // total cap = ceil(4 / 0.5) = 8 <= 10
    expect(countSetTotal).toHaveBeenCalledWith(8);
  });
});
