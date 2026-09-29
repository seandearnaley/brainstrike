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
  assertListingMatchesCatalog,
  CrashGateCheckError,
  listIndexes,
  planUsesIndex,
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

  it.each(['bm25', 'btree', 'gin', 'hnsw'])(
    'lists every %s index that pg_indexes knows, so amcheck and the probes miss none',
    async (accessMethod) => {
      const oracle = await db.query<{ indexname: string }>(
        `SELECT x.indexname FROM pg_indexes x
         JOIN pg_namespace n ON n.nspname = x.schemaname
         JOIN pg_class c ON c.relname = x.indexname AND c.relnamespace = n.oid
         JOIN pg_am am ON am.oid = c.relam
         WHERE am.amname = $1 AND x.schemaname = 'public' ORDER BY 1`,
        [accessMethod]
      );
      expect(oracle.rows.length).toBeGreaterThan(0);

      const listed = await listIndexes(db, accessMethod);

      expect(listed.map((entry) => entry.indexName).sort()).toEqual(
        oracle.rows.map((row) => row.indexname).sort()
      );
    }
  );

  it('checks the listing against pg_indexes by name, so a drop and a duplicate cannot cancel out', async () => {
    const listed = await listIndexes(db, 'btree');
    // A listing that dropped one index and duplicated another has the right count and the wrong set.
    const tampered = [...listed.slice(1), listed[1] as (typeof listed)[number]];

    await expect(assertListingMatchesCatalog(db, 'btree', tampered)).rejects.toMatchObject({
      check: 'index-coverage',
    });
    await expect(assertListingMatchesCatalog(db, 'btree', listed)).resolves.toBeUndefined();
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

  it('counts only a scan node through the index, never the index name elsewhere in the plan', async () => {
    // The BM25 probe names its index in the query text; a Seq Scan's Filter or a Sort Key would
    // print that name without any index scan having run.
    await db.exec('SET enable_seqscan = off');
    const seqScan = `SELECT ctid FROM public.file_chunks WHERE content <> 'idx_file_chunks_content_bm25'`;
    const indexScan = `SELECT ctid FROM public.file_chunks ORDER BY content <@> to_bm25query('database recovery index', 'idx_file_chunks_content_bm25') LIMIT 10`;

    expect(await planUsesIndex(db, seqScan, 'idx_file_chunks_content_bm25')).toBe(false);
    expect(await planUsesIndex(db, indexScan, 'idx_file_chunks_content_bm25')).toBe(true);
    // A name that merely starts with another index's name is not that index.
    expect(await planUsesIndex(db, indexScan, 'idx_file_chunks_content_bm')).toBe(false);
  });

  it('never counts an index scanned only inside an InitPlan as the probe scanning through it', async () => {
    await db.exec(
      `INSERT INTO file_records (id, name, path, size) VALUES ('probe-file', 'p', '/p', 0);
       INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash)
       SELECT 'probe-' || g, 'probe-file', g, 'database recovery index ' || g, md5(g::text)
       FROM generate_series(1, 50) AS g`
    );
    await db.exec('SET enable_seqscan = off');
    // The outer scan goes through the content_hash btree; only the InitPlan ranks through BM25.
    const initPlanOnly = `SELECT ctid FROM public.file_chunks WHERE content_hash = (
      SELECT content_hash FROM public.file_chunks
      ORDER BY content <@> to_bm25query('database recovery index', 'idx_file_chunks_content_bm25')
      LIMIT 1)`;

    expect(await planUsesIndex(db, initPlanOnly, 'idx_file_chunks_content_bm25')).toBe(false);
  });

  it('fails an HNSW index with no rows to probe rather than passing vacuously', async () => {
    const failure = await verifyHnsw(db).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CrashGateCheckError);
    expect(failure).toMatchObject({ check: 'hnsw' });
    expect((failure as Error).message).toContain('would prove nothing');
  });
});
