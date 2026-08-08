import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmbeddingDimensionCache,
  MAX_EMBEDDING_DIMENSION,
  type Queryable,
  validateEmbeddingDimensions,
} from '../src/repositories/_shared.js';

interface DimensionRequest {
  readonly params: unknown[] | undefined;
  readonly sql: string;
}

function createDimensionDb(dimensionsById: ReadonlyMap<string, unknown>): {
  readonly db: Queryable;
  readonly requests: DimensionRequest[];
} {
  const requests: DimensionRequest[] = [];
  const db: Queryable = {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      requests.push({ params, sql });
      const ids = params?.[0];
      if (!(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
        throw new Error('Expected embedding set IDs as the first query parameter.');
      }
      const rows = ids.flatMap((id) => {
        const dimensions = dimensionsById.get(id);
        return dimensions === undefined ? [] : [{ dimensions, id }];
      });
      return { rows: rows as T[] };
    },
  };
  return { db, requests };
}

function embedded(
  embeddingSetId: string,
  dimension = 3
): {
  embedding: number[];
  embeddingSetId: string;
} {
  return { embedding: Array.from({ length: dimension }, () => 0.25), embeddingSetId };
}

describe('validateEmbeddingDimensions batch edge cases', () => {
  beforeEach(() => {
    clearEmbeddingDimensionCache();
  });

  it('does not query for an empty batch or records without embeddings', async () => {
    const { db, requests } = createDimensionDb(new Map([['set-a', 3]]));

    await validateEmbeddingDimensions(db, []);
    await validateEmbeddingDimensions(db, [{ embeddingSetId: 'set-a' }, {}]);

    expect(requests).toEqual([]);
  });

  it('uses expectedDimension without an embedding set ID', async () => {
    const { db, requests } = createDimensionDb(new Map());

    await validateEmbeddingDimensions(db, [{ embedding: [0.1, 0.2, 0.3], expectedDimension: 3 }]);
    await validateEmbeddingDimensions(db, [
      { embedding: [0.1, 0.2, 0.3], embeddingSetId: null, expectedDimension: 3 },
    ]);
    await expect(
      validateEmbeddingDimensions(db, [{ embedding: [0.1, 0.2], expectedDimension: 3 }])
    ).rejects.toThrow('Embedding dimension mismatch: received 2, expected 3.');

    expect(requests).toEqual([]);
  });

  it('prefers the embedding set dimension when expectedDimension is also supplied', async () => {
    const { db, requests } = createDimensionDb(new Map([['set-a', 3]]));

    await validateEmbeddingDimensions(db, [
      { ...embedded('set-a'), expectedDimension: MAX_EMBEDDING_DIMENSION },
    ]);
    await expect(validateEmbeddingDimensions(db, [embedded('set-a', 4)])).rejects.toThrow(
      'Embedding dimension mismatch: received 4, expected 3.'
    );

    expect(requests).toHaveLength(1);
  });

  it('throws when an embedding set is unknown', async () => {
    const { db } = createDimensionDb(new Map([['set-a', 3]]));

    await expect(
      validateEmbeddingDimensions(db, [embedded('set-a'), embedded('set-missing')])
    ).rejects.toThrow('Embedding set set-missing is missing or has invalid dimensions.');
  });

  it.each([
    ['non-numeric', 'not-a-number', 'Embedding set set-bad is missing or has invalid dimensions'],
    ['non-positive', 0, 'Embedding set set-bad is missing or has invalid dimensions'],
    [
      'oversized',
      MAX_EMBEDDING_DIMENSION + 1,
      `Embedding set set-bad defines ${MAX_EMBEDDING_DIMENSION + 1} dimensions`,
    ],
  ])('rejects a set row with a %s dimension', async (_case, dimensions, message) => {
    const { db } = createDimensionDb(new Map([['set-bad', dimensions]]));

    await expect(validateEmbeddingDimensions(db, [embedded('set-bad')])).rejects.toThrow(message);
  });

  it('deduplicates mixed embedding set IDs into one ANY query', async () => {
    const { db, requests } = createDimensionDb(
      new Map([
        ['set-a', 3],
        ['set-b', 3],
      ])
    );

    await validateEmbeddingDimensions(db, [
      embedded('set-a'),
      embedded('set-a'),
      embedded('set-b'),
      embedded('set-b'),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.sql).toMatch(/WHERE id = ANY\(\$1\)/);
    expect(requests[0]?.params).toEqual([['set-a', 'set-b']]);
  });

  it('serves a fully cached batch without another query', async () => {
    const { db, requests } = createDimensionDb(new Map([['set-a', 3]]));

    await validateEmbeddingDimensions(db, [embedded('set-a')]);
    requests.length = 0;
    await validateEmbeddingDimensions(db, [embedded('set-a'), embedded('set-a')]);

    expect(requests).toEqual([]);
  });

  it('queries only uncached IDs on a partial cache hit', async () => {
    const { db, requests } = createDimensionDb(
      new Map([
        ['set-a', 3],
        ['set-b', 3],
      ])
    );

    await validateEmbeddingDimensions(db, [embedded('set-a')]);
    requests.length = 0;
    await validateEmbeddingDimensions(db, [
      embedded('set-a'),
      embedded('set-b'),
      embedded('set-b'),
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual([['set-b']]);
  });

  it('keeps a very large batch to one query with unique IDs', async () => {
    const dimensionsById = new Map(
      Array.from({ length: 250 }, (_, index) => [`set-${index}`, 3] as const)
    );
    const { db, requests } = createDimensionDb(dimensionsById);
    const batch = Array.from({ length: 10_000 }, (_, index) => embedded(`set-${index % 250}`));

    await validateEmbeddingDimensions(db, batch);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual([Array.from(dimensionsById.keys())]);

    requests.length = 0;
    await validateEmbeddingDimensions(db, [embedded('set-0'), embedded('set-249')]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual([['set-0']]);
  });
});
