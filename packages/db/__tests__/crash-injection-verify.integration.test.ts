/**
 * BST-1875: the crash gate's verifier on the real migrated schema. The gate claims to check EVERY
 * index of each access method; these tests pin that claim, including the expression-key
 * `idx_file_chunks_emb_hnsw_<N>` indexes production builds per embedding dimension, which an
 * `indkey[0]` join silently drops.
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDimensionIndex, hnswParams } from '../src/migrations/dimension-index-helpers';
import { catalogEmbeddingDimensions } from './helpers/crash-injection-protocol';
import {
  CrashGateCheckError,
  listIndexes,
  verifyHnsw,
  verifyIndexValidity,
} from './helpers/crash-injection-verify';
import { createMigratedTestDb } from './helpers/migrated-test-db';

async function indexNames(db: PGlite, like: string): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE indexname LIKE $1 ORDER BY 1',
    [like]
  );
  return result.rows.map((row) => row.indexname);
}

describe('crash gate verifier (real migrated schema)', () => {
  let db: PGlite;
  let dimensions: number[];

  beforeEach(async () => {
    db = await createMigratedTestDb();
    dimensions = await catalogEmbeddingDimensions(db);
    for (const dimension of dimensions) {
      await createDimensionIndex(db, dimension, hnswParams());
    }
  });

  afterEach(async () => {
    await db.close();
  });

  it('lists every HNSW index, expression keys and partial predicates included', async () => {
    // The oracle is pg_indexes, not the verifier's own catalog query.
    const production = await indexNames(db, 'idx\\_file\\_chunks\\_emb\\_hnsw\\_%');
    expect(production).toHaveLength(dimensions.length);
    expect(dimensions.length).toBeGreaterThan(1);

    const listed = await listIndexes(db, 'hnsw');
    expect(listed.map((entry) => entry.indexName).sort()).toEqual(
      [...production, 'idx_thread_message_index_embedding_hnsw'].sort()
    );
    const half = listed.find((entry) => entry.indexName === production[0]);
    expect(half?.key).toMatch(/^\(embedding::halfvec\(\d+\)\)$/u);
    expect(half?.operatorClass).toBe('halfvec_cosine_ops');
    expect(half?.predicate).toMatch(/vector_dims\(embedding\)/u);
  });

  it('lists the BM25 index by its column key', async () => {
    const [bm25] = await listIndexes(db, 'bm25');
    expect(bm25).toMatchObject({ indexName: 'idx_file_chunks_content_bm25', key: 'content' });
  });

  it('fails an index that is not valid, instead of filtering it out of every check', async () => {
    await verifyIndexValidity(db);
    await db.exec(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_file_chunks_content_hash'::regclass`
    );

    await expect(verifyIndexValidity(db)).rejects.toMatchObject({
      check: 'index-validity',
      subject: 'public.idx_file_chunks_content_hash',
    });
    // The listing keeps it, so amcheck would still be aimed at it.
    expect((await listIndexes(db, 'btree')).map((entry) => entry.indexName)).toContain(
      'idx_file_chunks_content_hash'
    );
  });

  it('fails an HNSW index with no rows to probe rather than passing vacuously', async () => {
    const failure = await verifyHnsw(db).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrashGateCheckError);
    expect(failure).toMatchObject({ check: 'hnsw' });
    expect((failure as Error).message).toContain('would prove nothing');
  });
});
