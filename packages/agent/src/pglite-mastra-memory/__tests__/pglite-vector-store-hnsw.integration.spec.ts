import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgliteVectorStore } from '../vector-store';

async function readIndexDef(db: PGlite, indexName: string): Promise<string | null> {
  const result = await db.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'mastra_vectors' AND indexname = $1`,
    [indexName]
  );
  return result.rows[0]?.indexdef ?? null;
}

describe('PgliteVectorStore per-dimension HNSW indexes', () => {
  let db: PGlite;
  let store: PgliteVectorStore;

  beforeEach(async () => {
    db = await PGlite.create({ extensions: { vector } });
    store = new PgliteVectorStore({ database: db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates a partial halfvec HNSW index when a new index dimension is declared', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });

    const indexDef = await readIndexDef(db, 'idx_mastra_vectors_emb_hnsw_3_cosine');
    expect(indexDef).not.toBeNull();
    expect(indexDef).toContain('USING hnsw');
    expect(indexDef).toContain('halfvec(3)');
    expect(indexDef).toContain('halfvec_cosine_ops');
    expect(indexDef).toContain('vector_dims(embedding) = 3');
  });

  it('restores a missing HNSW index when an existing logical index is re-declared', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await db.query('DROP INDEX idx_mastra_vectors_emb_hnsw_3_cosine');

    // A fresh store hitting the existing-index early-return branch (the every-session
    // Mastra init path) must still ensure the physical index for pre-existing installs.
    const rehydratedStore = new PgliteVectorStore({ database: db });
    await rehydratedStore.createIndex({
      dimension: 3,
      indexName: 'memory_messages',
      metric: 'cosine',
    });

    await expect(readIndexDef(db, 'idx_mastra_vectors_emb_hnsw_3_cosine')).resolves.toContain(
      'USING hnsw'
    );
  });

  it('keeps distinct dimensions and metrics in separate partial indexes', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.createIndex({
      dimension: 4,
      indexName: 'observational_memory',
      metric: 'euclidean',
    });

    const cosineDef = await readIndexDef(db, 'idx_mastra_vectors_emb_hnsw_3_cosine');
    expect(cosineDef).toContain('halfvec_cosine_ops');
    expect(cosineDef).toContain('vector_dims(embedding) = 3');

    const euclideanDef = await readIndexDef(db, 'idx_mastra_vectors_emb_hnsw_4_euclidean');
    expect(euclideanDef).toContain('halfvec_l2_ops');
    expect(euclideanDef).toContain('vector_dims(embedding) = 4');
  });

  it('plans semantic queries through the partial HNSW index', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.upsert({
      ids: ['message-a', 'message-b', 'message-c'],
      indexName: 'memory_messages',
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
      ],
    });

    // Mirror the store's query shape: with seq scans disabled, the planner can only
    // satisfy the halfvec ORDER BY + vector_dims predicate through the partial index.
    await db.query('SET enable_seqscan = off');
    try {
      const plan = await db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN
         SELECT id
         FROM mastra_vectors
         WHERE index_name = 'memory_messages'
           AND id <> '__index_metadata__'
           AND vector_dims(embedding) = 3
         ORDER BY (embedding::halfvec(3)) <=> '[1,0,0]'::halfvec(3)
         LIMIT 2`
      );
      const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(planText).toContain('idx_mastra_vectors_emb_hnsw_3_cosine');
    } finally {
      await db.query('RESET enable_seqscan');
    }
  });

  it('returns correctly ordered results through the indexed query path', async () => {
    await store.createIndex({ dimension: 3, indexName: 'memory_messages', metric: 'cosine' });
    await store.upsert({
      ids: ['message-a', 'message-b', 'message-c'],
      indexName: 'memory_messages',
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0, 1, 0],
      ],
    });

    const results = await store.query({
      indexName: 'memory_messages',
      queryVector: [1, 0, 0],
      topK: 3,
    });

    expect(results.map((result) => result.id)).toEqual(['message-a', 'message-b', 'message-c']);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? Number.NaN);
    expect(results[1]?.score).toBeGreaterThan(results[2]?.score ?? Number.NaN);
  });

  it('skips index creation beyond the halfvec HNSW ceiling but keeps queries working', async () => {
    const dimension = 4001;
    const baseVector = new Array<number>(dimension).fill(0);
    const nearVector = [...baseVector];
    nearVector[0] = 1;
    const farVector = [...baseVector];
    farVector[1] = 1;

    await store.createIndex({ dimension, indexName: 'memory_wide', metric: 'cosine' });
    await expect(
      readIndexDef(db, `idx_mastra_vectors_emb_hnsw_${dimension}_cosine`)
    ).resolves.toBeNull();

    await store.upsert({
      ids: ['near', 'far'],
      indexName: 'memory_wide',
      vectors: [nearVector, farVector],
    });
    const results = await store.query({
      indexName: 'memory_wide',
      queryVector: nearVector,
      topK: 2,
    });
    expect(results.map((result) => result.id)).toEqual(['near', 'far']);
  });
});
