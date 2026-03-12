import { beforeEach, describe, it, vi } from 'vitest';
import { migrations } from '../src/migrations/index.js';
import { MigrationRunner } from '../src/migrations/migration-runner.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('validateEmbeddingDimensions performance', () => {
  let db: any;
  let repo: FileChunkRepository;
  let set1Id: string;
  let set2Id: string;

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

  it('measures queries for insertMany', async () => {
    // Before test, let's clear the local dimension cache if it's exported or we just rely on first run
    const querySpy = vi.spyOn(db, 'query');

    const chunks = Array.from({ length: 50 }, (_, i) => ({
      id: `chunk-${i}`,
      fileRecordId: 'file-1',
      chunkIndex: i,
      content: `content-${i}`,
      contentHash: `hash-${i}`,
      tokenCount: 1,
      chunkType: 'text' as const,
      chunkSize: 10,
      embedding: [0.1, 0.2, 0.3],
      embeddingSetId: i % 2 === 0 ? set1Id : set2Id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const start = performance.now();
    await repo.insertMany(chunks);
    const end = performance.now();

    const selectQueries = querySpy.mock.calls.filter((c) =>
      c[0].includes('SELECT dimensions FROM embedding_sets')
    ).length;

    console.log(`insertMany took ${end - start}ms`);
    console.log(`Made ${selectQueries} SELECT queries for dimensions`);
  });
});
