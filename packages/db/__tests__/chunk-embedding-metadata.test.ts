import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileChunkInsert, FileChunkUpdate } from '../src/models/file-chunk.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

function makeVector(dim: number, entries: [number, number][]): number[] {
  const vector = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    vector[idx] = value;
  }
  return vector;
}

describe('Chunk embedding metadata', () => {
  let db: PGlite;
  let chunkRepo: FileChunkRepository;
  let fileRepo: FileRecordRepository;
  let setRepo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    fileRepo = new FileRecordRepository(db);
    chunkRepo = new FileChunkRepository(db);
    setRepo = new EmbeddingSetsRepository(db);

    // seed a file record
    const now = new Date().toISOString();
    await fileRepo.create({
      createdAt: now,
      id: 'fileA',
      name: 'a.txt',
      path: '/a.txt',
      size: 1,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores embedding_set_id and embedding_hash when embedding updated', async () => {
    const now = new Date().toISOString();
    const chunk: FileChunkInsert = {
      chunkIndex: 0,
      chunkSize: 10,
      chunkType: 'text',
      content: 'x',
      contentHash: 'hash-x',
      createdAt: now,
      fileRecordId: 'fileA',
      id: 'c1',
      tokenCount: 1,
      updatedAt: now,
    };
    await chunkRepo.insert(chunk);

    const set = await setRepo.getOrCreateSet('bge-m3', 'Xenova/bge-m3', 768, 'cosine');
    const update: FileChunkUpdate = {
      embedding: makeVector(768, [
        [0, 0.1],
        [1, 0.2],
        [2, 0.3],
      ]),
      embeddingHash: 'ehash-1',
      embeddingSetId: set.id,
      id: 'c1',
      updatedAt: new Date().toISOString(),
    };

    const updated = await chunkRepo.update(update);
    expect(updated?.embeddingSetId).toBe(set.id);
    expect(updated?.embeddingHash).toBe('ehash-1');
    expect(updated?.embeddingUpdatedAt).toBeDefined();
  });

  it('filters search by embeddingSetId when provided', async () => {
    const now = new Date().toISOString();
    const setA = await setRepo.getOrCreateSet('setA', 'model-setA', 768, 'cosine');
    const setB = await setRepo.getOrCreateSet('setB', 'model-setB', 768, 'cosine');
    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 10,
        chunkType: 'text',
        content: 'x',
        contentHash: 'h1',
        createdAt: now,
        embedding: makeVector(768, [[0, 0.1]]),
        embeddingHash: 'eh1',
        embeddingSetId: setA.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'fileA',
        id: 'c1',
        tokenCount: 1,
        updatedAt: now,
      },
      {
        chunkIndex: 1,
        chunkSize: 10,
        chunkType: 'text',
        content: 'y',
        contentHash: 'h2',
        createdAt: now,
        embedding: makeVector(768, [[1, 0.1]]),
        embeddingHash: 'eh2',
        embeddingSetId: setB.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'fileA',
        id: 'c2',
        tokenCount: 1,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.1]]);

    const resultsAll = await chunkRepo.searchSimilar(query, {
      embeddingSetId: setA.id,
      limit: 10,
      threshold: 0.6,
    });
    expect(resultsAll.length).toBe(1);
    expect(resultsAll[0].chunk.id).toBe('c1');

    const resultsSetB = await chunkRepo.searchSimilar(query, {
      embeddingSetId: setB.id,
      limit: 10,
      threshold: 0.6,
    });
    expect(resultsSetB.length).toBe(0);
  });
});
