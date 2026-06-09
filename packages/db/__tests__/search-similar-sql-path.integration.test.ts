import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

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
    const db: PGlite = await wasmLoader.createPGlite('memory://sql-ok');
    await migrate(db);

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
        id: 'c1',
        fileRecordId: 'f1',
        chunkIndex: 0,
        content: 'A',
        contentHash: 'h1',
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 1,
        embedding: e1,
        embeddingSetId: setId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c2',
        fileRecordId: 'f1',
        chunkIndex: 1,
        content: 'B',
        contentHash: 'h2',
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 1,
        embedding: e2,
        embeddingSetId: setId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c3',
        fileRecordId: 'f1',
        chunkIndex: 2,
        content: 'C',
        contentHash: 'h3',
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 1,
        embedding: e3,
        embeddingSetId: setId,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const repo = new FileChunkRepository(db);
    await repo.insertMany(chunks);

    // Using chunkType narrows WHERE and increments param indexes before set lookup.
    // Previously, this triggered a bad parameter index in the standalone set query.
    const results = await repo.searchSimilar(q, {
      limit: 10,
      threshold: 0,
      chunkType: 'text',
      embeddingSetId: setId,
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
      limit: 10,
      threshold: 0,
      chunkType: 'text',
      embeddingSetId: setId,
      includeEmbedding: true,
    });
    for (const r of withVector) {
      expect(Array.isArray(r.chunk.embedding)).toBe(true);
      expect(r.chunk.embedding?.length).toBe(dim);
    }

    // Higher threshold should filter to only the most similar one
    const strict = await repo.searchSimilar(q, {
      limit: 10,
      threshold: 0.85,
      chunkType: 'text',
      embeddingSetId: setId,
    });
    expect(strict.map((r) => r.chunk.id)).toEqual(['c1']);

    // includeEmbedding: false must still rank correctly (distance is computed in
    // SQL), but omit the heavy vector payload while preserving the dimension
    // count via vector_dims() so consumers can still show "N dims".
    const projected = await repo.searchSimilar(q, {
      limit: 10,
      threshold: 0,
      chunkType: 'text',
      embeddingSetId: setId,
      includeEmbedding: false,
    });
    expect(projected.map((r) => r.chunk.id)).toEqual(['c1', 'c2', 'c3']);
    for (const r of projected) {
      expect(r.chunk.embedding).toBeUndefined();
      expect(r.chunk.embeddingDimensions).toBe(dim);
    }
  });
});
