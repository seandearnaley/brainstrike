import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrations } from '../src/migrations/index.js';
import { MigrationRunner } from '../src/migrations/migration-runner.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

// NOTE: The embedding dimension cache in _shared.ts is module-scoped and
// persists across tests. Each test uses unique embedding set IDs created via
// PGlite in-memory databases, so stale cache entries do not affect results.
// If a future test needs to verify uncached paths, expose a cache-clear
// helper or use dependency injection.
describe('validateEmbeddingDimensions batch N+1 regression', () => {
  let db: PGlite;
  let repo: FileChunkRepository;
  let set1Id: string;
  let set2Id: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db?.close();
  });

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://benchmark-n1');
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);

    const setRepo = new EmbeddingSetsRepository(db);
    const set1 = await setRepo.getOrCreateSet('set-1', 'model1', 3, 'cosine');
    const set2 = await setRepo.getOrCreateSet('set-2', 'model2', 3, 'cosine');
    set1Id = set1.id;
    set2Id = set2.id;

    await db.query(`
      INSERT INTO file_records (id, name, path, size, created_at, updated_at)
      VALUES ('file-1', 'a.txt', '/a.txt', 10, now(), now())
    `);

    repo = new FileChunkRepository(db);
  });

  it('uses at most one dimension SELECT for insertMany (no N+1)', async () => {
    const querySpy = vi.spyOn(db, 'query');

    const chunks = Array.from({ length: 50 }, (_, i) => ({
      chunkIndex: i,
      chunkSize: 10,
      chunkType: 'text' as const,
      content: `content-${i}`,
      contentHash: `hash-${i}`,
      createdAt: new Date().toISOString(),
      embedding: [0.1, 0.2, 0.3],
      embeddingSetId: i % 2 === 0 ? set1Id : set2Id,
      fileRecordId: 'file-1',
      id: `chunk-${i}`,
      tokenCount: 1,
      updatedAt: new Date().toISOString(),
    }));

    await repo.insertMany(chunks);

    const dimensionSelectPattern = /SELECT\b[^;]*\bdimensions\b[^;]*\bFROM\s+embedding_sets\b/i;
    const dimensionQueries = querySpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && dimensionSelectPattern.test(c[0])
    ).length;
    const totalQueries = querySpy.mock.calls.length;

    // Batch approach should use at most 1 SELECT query for dimensions (not N per chunk)
    expect(dimensionQueries).toBeLessThanOrEqual(1);

    // Total queries should be well below 50 (the chunk count), proving no N+1
    expect(totalQueries).toBeLessThan(50);

    // Verify all chunks were actually inserted
    const { rows } = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM file_chunks'
    );
    expect(rows[0].cnt).toBe(50);
  });

  it('rejects a batch when one chunk has a wrong embedding dimension', async () => {
    const chunks = [
      {
        chunkIndex: 0,
        chunkSize: 4,
        chunkType: 'text' as const,
        content: 'good',
        contentHash: 'hash-ok-1',
        createdAt: new Date().toISOString(),
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: set1Id,
        fileRecordId: 'file-1',
        id: 'chunk-ok-1',
        tokenCount: 1,
        updatedAt: new Date().toISOString(),
      },
      {
        chunkIndex: 1,
        chunkSize: 13,
        chunkType: 'text' as const,
        content: 'bad dimension',
        contentHash: 'hash-bad',
        createdAt: new Date().toISOString(),
        // 5-element vector vs expected 3 dimensions
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        embeddingSetId: set1Id,
        fileRecordId: 'file-1',
        id: 'chunk-bad',
        tokenCount: 1,
        updatedAt: new Date().toISOString(),
      },
      {
        chunkIndex: 2,
        chunkSize: 9,
        chunkType: 'text' as const,
        content: 'also good',
        contentHash: 'hash-ok-2',
        createdAt: new Date().toISOString(),
        embedding: [0.4, 0.5, 0.6],
        embeddingSetId: set2Id,
        fileRecordId: 'file-1',
        id: 'chunk-ok-2',
        tokenCount: 1,
        updatedAt: new Date().toISOString(),
      },
    ];

    await expect(repo.insertMany(chunks)).rejects.toThrow(
      'Embedding dimension mismatch: received 5, expected 3.'
    );

    // Verify no chunks were persisted (transaction should have rolled back)
    const { rows } = await db.query<{ cnt: number }>(
      'SELECT count(*)::int AS cnt FROM file_chunks'
    );
    expect(rows[0].cnt).toBe(0);
  });
});
