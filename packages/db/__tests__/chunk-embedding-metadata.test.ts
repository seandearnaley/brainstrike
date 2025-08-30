import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert, FileChunkUpdate } from '../src/models/file-chunk.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';

describe('Chunk embedding metadata', () => {
  let db: PGlite;
  let chunkRepo: FileChunkRepository;
  let fileRepo: FileRecordRepository;
  let setRepo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = new PGlite('memory://');
    await migrate(db);
    fileRepo = new FileRecordRepository(db);
    chunkRepo = new FileChunkRepository(db, false);
    setRepo = new EmbeddingSetsRepository(db);

    // seed a file record
    const now = new Date().toISOString();
    await fileRepo.create({
      id: 'fileA',
      name: 'a.txt',
      path: '/a.txt',
      size: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores embedding_set_id and embedding_hash when embedding updated', async () => {
    const now = new Date().toISOString();
    const chunk: FileChunkInsert = {
      id: 'c1',
      fileRecordId: 'fileA',
      chunkIndex: 0,
      content: 'x',
      contentHash: 'hash-x',
      tokenCount: 1,
      chunkType: 'text',
      chunkSize: 10,
      createdAt: now,
      updatedAt: now,
    };
    await chunkRepo.insert(chunk);

    const set = await setRepo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 1024, 'cosine');
    const update: FileChunkUpdate = {
      id: 'c1',
      embedding: [0.1, 0.2, 0.3],
      embeddingSetId: set.id,
      embeddingHash: 'ehash-1',
      updatedAt: new Date().toISOString(),
    };

    const updated = await chunkRepo.update(update);
    expect(updated?.embeddingSetId).toBe(set.id);
    expect(updated?.embeddingHash).toBe('ehash-1');
    expect(updated?.embeddingUpdatedAt).toBeDefined();
  });

  it('filters search by embeddingSetId when provided (client-side path)', async () => {
    const now = new Date().toISOString();
    const chunks: FileChunkInsert[] = [
      {
        id: 'c1',
        fileRecordId: 'fileA',
        chunkIndex: 0,
        content: 'x',
        contentHash: 'h1',
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 10,
        embedding: [0.1, 0.0, 0.0],
        embeddingSetId: 'setA',
        embeddingUpdatedAt: now,
        embeddingHash: 'eh1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c2',
        fileRecordId: 'fileA',
        chunkIndex: 1,
        content: 'y',
        contentHash: 'h2',
        tokenCount: 1,
        chunkType: 'text',
        chunkSize: 10,
        embedding: [0.1, 0.0, 0.0],
        embeddingSetId: 'setB',
        embeddingUpdatedAt: now,
        embeddingHash: 'eh2',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const resultsAll = await chunkRepo.searchSimilar([0.1, 0.0, 0.0], {
      limit: 10,
      threshold: 0,
    });
    expect(resultsAll.length).toBe(2);

    const resultsSetA = await chunkRepo.searchSimilar([0.1, 0.0, 0.0], {
      limit: 10,
      threshold: 0,
      embeddingSetId: 'setA',
    });
    expect(resultsSetA.length).toBe(1);
    expect(resultsSetA[0].chunk.id).toBe('c1');
  });
});
