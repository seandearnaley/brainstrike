import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type {
  FileChunkDatabase,
  FileChunkQueryTx,
} from '../src/repositories/file-chunk-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

// Utility to build a dense vector of a given dimension with provided entries
function makeVector(dim: number, entries: [number, number][]): number[] {
  const v = new Array(dim).fill(0);
  for (const [idx, val] of entries) {
    v[idx] = val;
  }
  return v;
}

describe('searchSimilar SQL path (pgvector integration)', () => {
  it('returns ranked results and does not regress parameter indexing', async () => {
    const db: PGlite = await createMigratedTestDb();
    onTestFinished(() => db.close());

    // Sanity: ensure vector extension is available
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create an embedding set (cosine, 768 dims)
    const setId = 'set_cos';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [setId, 'bge-m3', 'bge-m3', 768, 'cosine']
    );

    // Insert a file record
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['f1', 'file.txt', '/tmp/file.txt', 1, now, now]
    );

    // Prepare 3 chunks with known cosine similarities to the query vector
    const dim = 768;
    const q = makeVector(dim, [[0, 1.0]]); // unit on index 0
    const e1 = makeVector(dim, [[0, 1.0]]); // identical (sim = 1)
    const e2 = makeVector(dim, [
      [0, 0.6],
      [1, 0.8],
    ]); // mixed (cos ~ 0.6, mapped sim ~ 0.8)
    const e3 = makeVector(dim, [[1, 1.0]]); // orthogonal (cos ~ 0, mapped sim ~ 0.5)

    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 1,
        chunkType: 'text',
        content: 'A',
        contentHash: 'h1',
        createdAt: now,
        embedding: e1,
        embeddingSetId: setId,
        fileRecordId: 'f1',
        id: 'c1',
        tokenCount: 1,
        updatedAt: now,
      },
      {
        chunkIndex: 1,
        chunkSize: 1,
        chunkType: 'text',
        content: 'B',
        contentHash: 'h2',
        createdAt: now,
        embedding: e2,
        embeddingSetId: setId,
        fileRecordId: 'f1',
        id: 'c2',
        tokenCount: 1,
        updatedAt: now,
      },
      {
        chunkIndex: 2,
        chunkSize: 1,
        chunkType: 'text',
        content: 'C',
        contentHash: 'h3',
        createdAt: now,
        embedding: e3,
        embeddingSetId: setId,
        fileRecordId: 'f1',
        id: 'c3',
        tokenCount: 1,
        updatedAt: now,
      },
    ];

    const repo = new FileChunkRepository(db);
    await repo.insertMany(chunks);

    // Using chunkType narrows WHERE and increments param indexes before set lookup.
    // Previously, this triggered a bad parameter index in the standalone set query.
    const results = await repo.searchSimilar(q, {
      chunkType: 'text',
      embeddingSetId: setId,
      limit: 10,
      threshold: 0,
    });

    // Should return all three, correctly ranked
    expect(results.map((r) => r.chunk.id)).toEqual(['c1', 'c2', 'c3']);
    expect(results[0].similarity).toBeGreaterThanOrEqual(0.99); // ~1
    expect(results[1].similarity).toBeGreaterThan(results[2].similarity);

    // PR3: the DEFAULT now projects the heavy embedding vector away to keep the
    // search payload off the IPC wire. Ranking is unaffected (distance is in SQL),
    // and the dimension count is preserved via vector_dims() for UI labels.
    for (const r of results) {
      expect(r.chunk.embedding).toBeUndefined();
      expect(r.chunk.embeddingDimensions).toBe(dim);
    }

    // Callers that genuinely need the vector must opt in explicitly.
    const withVector = await repo.searchSimilar(q, {
      chunkType: 'text',
      embeddingSetId: setId,
      includeEmbedding: true,
      limit: 10,
      threshold: 0,
    });
    for (const r of withVector) {
      expect(Array.isArray(r.chunk.embedding)).toBe(true);
      expect(r.chunk.embedding?.length).toBe(dim);
    }

    // Higher threshold should filter to only the most similar one
    const strict = await repo.searchSimilar(q, {
      chunkType: 'text',
      embeddingSetId: setId,
      limit: 10,
      threshold: 0.85,
    });
    expect(strict.map((r) => r.chunk.id)).toEqual(['c1']);

    // includeEmbedding: false must still rank correctly (distance is computed in
    // SQL), but omit the heavy vector payload while preserving the dimension
    // count via vector_dims() so consumers can still show "N dims".
    const projected = await repo.searchSimilar(q, {
      chunkType: 'text',
      embeddingSetId: setId,
      includeEmbedding: false,
      limit: 10,
      threshold: 0,
    });
    expect(projected.map((r) => r.chunk.id)).toEqual(['c1', 'c2', 'c3']);
    for (const r of projected) {
      expect(r.chunk.embedding).toBeUndefined();
      expect(r.chunk.embeddingDimensions).toBe(dim);
    }
  });

  it('scopes results to a single workspace root via the rootId option', async () => {
    const db: PGlite = await createMigratedTestDb();
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    const setId = 'set_root';
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [setId, 'bge-m3', 'bge-m3', 768, 'cosine']
    );
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ($1, 'path', $2, $3, 'live', $4), ($5, 'path', $6, $7, 'live', $8)`,
      ['root-a', 'ProjectA', '/work/A', now, 'root-b', 'ProjectB', '/work/B', now]
    );
    // Same relative path in two roots; identical embeddings so only the filter
    // (not the distance ranking) can separate them.
    await db.query(
      `INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
      [
        'fa',
        'doc.md',
        'doc.md',
        'root-a',
        1,
        now,
        now,
        'fb',
        'doc.md',
        'doc.md',
        'root-b',
        1,
        now,
        now,
      ]
    );

    const dim = 768;
    const q = makeVector(dim, [[0, 1.0]]);
    const e = makeVector(dim, [[0, 1.0]]);
    const repo = new FileChunkRepository(db);
    await repo.insertMany([
      {
        chunkIndex: 0,
        chunkSize: 1,
        chunkType: 'text',
        content: 'A',
        contentHash: 'ha',
        createdAt: now,
        embedding: e,
        embeddingSetId: setId,
        fileRecordId: 'fa',
        id: 'ca',
        tokenCount: 1,
        updatedAt: now,
      },
      {
        chunkIndex: 0,
        chunkSize: 1,
        chunkType: 'text',
        content: 'B',
        contentHash: 'hb',
        createdAt: now,
        embedding: e,
        embeddingSetId: setId,
        fileRecordId: 'fb',
        id: 'cb',
        tokenCount: 1,
        updatedAt: now,
      },
    ]);

    const all = await repo.searchSimilar(q, { embeddingSetId: setId, limit: 10, threshold: 0 });
    expect(all.map((r) => r.chunk.id).sort()).toEqual(['ca', 'cb']);

    const scoped = await repo.searchSimilar(q, {
      embeddingSetId: setId,
      limit: 10,
      rootId: 'root-b',
      threshold: 0,
    });
    expect(scoped.map((r) => r.chunk.id)).toEqual(['cb']);

    await db.close();
  });
});

// Selective narrowed searches must bypass the ANN index via an exact
// full-precision scan (the partial halfvec HNSW index returns as little as
// 39.5% recall@10 on ~10%-selective filters at 100k chunks — see
// docs/binary-quantization-two-stage-benchmark-2026-07-11.md). Route decisions
// come from bounded selectivity counts and must never run for un-narrowed
// whole-set searches.
describe('searchSimilar adaptive routing (selective filters)', () => {
  interface LoggingDb {
    db: FileChunkDatabase;
    log: string[];
    txCount: () => number;
  }

  function createLoggingDb(pg: PGlite): LoggingDb {
    const log: string[] = [];
    let tx = 0;
    const wrapTx = (queryable: FileChunkQueryTx): FileChunkQueryTx => ({
      query: async <T>(sql: string, params?: unknown[]) => {
        log.push(sql);
        return (await queryable.query(sql, params)) as { rows: T[] };
      },
    });
    return {
      db: {
        query: async <T>(sql: string, params?: unknown[]) => {
          log.push(sql);
          return (await pg.query(sql, params)) as { rows: T[] };
        },
        transaction: async <T>(fn: (t: FileChunkQueryTx) => Promise<T>) => {
          tx += 1;
          return await pg.transaction(async (t) => fn(wrapTx(t as FileChunkQueryTx)));
        },
      },
      log,
      txCount: () => tx,
    };
  }

  async function seedCorpus(pg: PGlite): Promise<{ dim: number; setId: string }> {
    await pg.query('CREATE EXTENSION IF NOT EXISTS vector');
    const dim = 8;
    const setId = 'set_route';
    const now = new Date().toISOString();
    await pg.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [setId, 'bge-m3', 'bge-m3', dim, 'cosine']
    );
    await pg.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ($1, 'path', $2, $3, 'live', $4), ($5, 'path', $6, $7, 'live', $8)`,
      ['root-broad', 'Broad', '/work/broad', now, 'root-narrow', 'Narrow', '/work/narrow', now]
    );
    await pg.query(
      `INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
      [
        'f-broad',
        'a.md',
        'a.md',
        'root-broad',
        1,
        now,
        now,
        'f-narrow',
        'b.md',
        'b.md',
        'root-narrow',
        1,
        now,
        now,
      ]
    );

    // 40 chunks in root-broad + 5 in root-narrow (45 total in the set):
    //  - root-narrow matched=5 -> total cap ceil(5/0.15)=34 <= 45 -> EXACT
    //  - root-broad matched=40 -> total cap ceil(40/0.15)=267 > 45 -> ANN
    // Cosine similarity to the axis-0 query decreases with the chunk index.
    const repo = new FileChunkRepository(pg);
    const chunks: FileChunkInsert[] = [];
    const addChunk = (id: string, fileRecordId: string, index: number): void => {
      const embedding = new Array(dim).fill(0);
      embedding[0] = 1;
      embedding[1] = index * 0.05;
      chunks.push({
        chunkIndex: index,
        chunkSize: 1,
        chunkType: 'text',
        content: id,
        contentHash: `h-${id}`,
        createdAt: now,
        embedding,
        embeddingSetId: setId,
        fileRecordId,
        id,
        tokenCount: 1,
        updatedAt: now,
      });
    };
    for (let i = 0; i < 40; i++) {
      addChunk(`broad-${i}`, 'f-broad', i);
    }
    for (let i = 0; i < 5; i++) {
      addChunk(`narrow-${i}`, 'f-narrow', i);
    }
    await repo.insertMany(chunks);
    return { dim, setId };
  }

  it('routes a selective root scope to an exact full-precision scan (no ANN tuning)', async () => {
    const pg: PGlite = await createMigratedTestDb();
    const { dim, setId } = await seedCorpus(pg);
    const logging = createLoggingDb(pg);
    const repo = new FileChunkRepository(logging.db);

    const q = makeVector(dim, [[0, 1.0]]);
    const results = await repo.searchSimilar(q, {
      embeddingSetId: setId,
      limit: 10,
      rootIds: ['root-narrow'],
      threshold: 0,
    });

    // Exact scan: full recall of the narrow root's chunks, ranked by cosine.
    expect(results.map((r) => r.chunk.id)).toEqual([
      'narrow-0',
      'narrow-1',
      'narrow-2',
      'narrow-3',
      'narrow-4',
    ]);

    // Bounded selectivity counts ran...
    expect(logging.log.some((sql) => sql.includes('SELECT COUNT(*)'))).toBe(true);
    // ...and the search itself ran OUTSIDE the tuned ANN transaction, ordered by
    // the full-precision vector op (which cannot match the halfvec HNSW index).
    expect(logging.txCount()).toBe(0);
    expect(logging.log.some((sql) => sql.includes('SET LOCAL'))).toBe(false);
    const searchSql = logging.log.find((sql) => sql.includes('ROW_NUMBER() OVER'));
    expect(searchSql).toBeDefined();
    expect(searchSql).toContain(`$1::vector(${dim})`);
    expect(searchSql).not.toContain('halfvec');

    await pg.close();
  });

  it('keeps a broad root scope on the tuned ANN path', async () => {
    const pg: PGlite = await createMigratedTestDb();
    const { dim, setId } = await seedCorpus(pg);
    const logging = createLoggingDb(pg);
    const repo = new FileChunkRepository(logging.db);

    const q = makeVector(dim, [[0, 1.0]]);
    const results = await repo.searchSimilar(q, {
      embeddingSetId: setId,
      limit: 5,
      rootIds: ['root-broad'],
      threshold: 0,
    });

    expect(results.map((r) => r.chunk.id)).toEqual([
      'broad-0',
      'broad-1',
      'broad-2',
      'broad-3',
      'broad-4',
    ]);
    // Counts ran (narrowed search), but the ratio is not selective -> ANN path
    // with its transaction-scoped HNSW tuning.
    expect(logging.log.some((sql) => sql.includes('SELECT COUNT(*)'))).toBe(true);
    expect(logging.txCount()).toBe(1);
    expect(logging.log.some((sql) => sql.includes('SET LOCAL hnsw.ef_search'))).toBe(true);
    const searchSql = logging.log.find((sql) => sql.includes('ROW_NUMBER() OVER'));
    expect(searchSql).toContain(`halfvec(${dim})`);

    await pg.close();
  });

  it('short-circuits an empty narrowed match to [] without running the search', async () => {
    const pg: PGlite = await createMigratedTestDb();
    const { dim, setId } = await seedCorpus(pg);
    const logging = createLoggingDb(pg);
    const repo = new FileChunkRepository(logging.db);

    const results = await repo.searchSimilar(makeVector(dim, [[0, 1.0]]), {
      embeddingSetId: setId,
      limit: 10,
      rootIds: ['root-that-does-not-exist'],
      threshold: 0,
    });

    expect(results).toEqual([]);
    expect(logging.log.some((sql) => sql.includes('ROW_NUMBER() OVER'))).toBe(false);
    expect(logging.txCount()).toBe(0);

    await pg.close();
  });

  it('never runs selectivity counts for un-narrowed whole-set searches', async () => {
    const pg: PGlite = await createMigratedTestDb();
    const { dim, setId } = await seedCorpus(pg);
    const logging = createLoggingDb(pg);
    const repo = new FileChunkRepository(logging.db);

    const results = await repo.searchSimilar(makeVector(dim, [[0, 1.0]]), {
      embeddingSetId: setId,
      limit: 3,
      threshold: 0,
    });

    expect(results).toHaveLength(3);
    // The dominant whole-set path pays ZERO selectivity-count overhead.
    expect(logging.log.some((sql) => sql.includes('SELECT COUNT(*)'))).toBe(false);
    expect(logging.txCount()).toBe(1); // tuned ANN transaction as before

    await pg.close();
  });
});
