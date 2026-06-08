/**
 * HNSW Search Tuning Integration Tests
 *
 * Validates that the transaction-scoped HNSW tuning (`hnsw.ef_search` +
 * `hnsw.iterative_scan`) actually takes effect on the bundled pgvector (0.8.x),
 * and that the FileChunkRepository search runs the tuning inside the SAME
 * transaction as the SELECT — the previous autocommit `SET LOCAL` was a no-op.
 *
 * Run with: TEST_ENABLE_VECTOR=true pnpm test hnsw-search-tuning.integration.test.ts
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { hnswSearchTuningStatements } from '../src/repositories/_shared.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

function makeVector(dim: number, entries: [number, number][]): number[] {
  const v = new Array(dim).fill(0);
  for (const [idx, val] of entries) {
    v[idx] = val;
  }
  return v;
}

describe('HNSW search tuning (pgvector integration)', () => {
  it('applies ef_search and iterative_scan inside a transaction (and not via autocommit)', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://hnsw-tuning');
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    const statements = hnswSearchTuningStatements(137);

    // Inside a transaction the GUCs take effect for subsequent statements.
    await db.query('BEGIN');
    for (const statement of statements) {
      await db.query(statement);
    }
    const inTx = await db.query(
      "SELECT current_setting('hnsw.ef_search') AS ef, current_setting('hnsw.iterative_scan') AS iter"
    );
    await db.query('COMMIT');

    const inTxRow = inTx.rows[0] as { ef: string; iter: string };
    expect(inTxRow.ef).toBe('137');
    // strict_order (not relaxed_order): exact distance ordering for the rank/slice.
    expect(inTxRow.iter).toBe('strict_order');

    // After COMMIT, the SET LOCAL values are gone — proving why the search must
    // run the tuning in the same transaction as the SELECT.
    const afterTx = await db.query("SELECT current_setting('hnsw.ef_search') AS ef");
    const afterTxRow = afterTx.rows[0] as { ef: string };
    expect(afterTxRow.ef).not.toBe('137');

    await db.close();
  });

  it('returns every match of a restrictive filter through the tuned transaction path', async () => {
    const db: PGlite = await wasmLoader.createPGlite('memory://hnsw-tuning-filter');
    await migrate(db);
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');

    const dim = 768;
    const setId = 'set_tuning';
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      [setId, 'bge-m3', 'bge-m3', dim, 'cosine']
    );

    const now = new Date().toISOString();
    // Two files: a large "noise" file and a small "target" file. The target's
    // chunks should all come back even though they are a small fraction of the set.
    const targetMatches = 6;
    const noiseCount = 120;
    for (const fileId of ['noise', 'target']) {
      await db.query(
        `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [fileId, `${fileId}.txt`, `/tmp/${fileId}.txt`, 1, now, now]
      );
    }

    const repo = new FileChunkRepository(db);
    const chunks: FileChunkInsert[] = [];
    // Noise chunks clustered near the query direction (index 0) so they dominate
    // the unfiltered ANN candidate window.
    for (let i = 0; i < noiseCount; i++) {
      chunks.push({
        id: `noise_${i}`,
        fileRecordId: 'noise',
        chunkIndex: i,
        content: `noise ${i}`,
        contentHash: `nh_${i}`,
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 1,
        embedding: makeVector(dim, [[0, 1.0]]),
        embeddingSetId: setId,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (let i = 0; i < targetMatches; i++) {
      chunks.push({
        id: `target_${i}`,
        fileRecordId: 'target',
        chunkIndex: i,
        content: `target ${i}`,
        contentHash: `th_${i}`,
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 1,
        embedding: makeVector(dim, [[0, 1.0]]),
        embeddingSetId: setId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await repo.insertMany(chunks);

    const query = makeVector(dim, [[0, 1.0]]);
    const results = await repo.searchSimilar(query, {
      limit: targetMatches,
      threshold: 0,
      embeddingSetId: setId,
      fileRecordId: 'target',
      // A deliberately small window: without iterative scans the filtered set
      // could under-return because the initial candidates are all "noise".
      efSearch: 1,
    });

    expect(results).toHaveLength(targetMatches);
    expect(results.every((r) => r.chunk.fileRecordId === 'target')).toBe(true);

    await db.close();
  });
});
