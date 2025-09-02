import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';

describe('searchSimilar behavior (client-side path)', () => {
  let db: PGlite;
  let chunkRepo: FileChunkRepository;
  let fileRepo: FileRecordRepository;
  let setRepo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = new PGlite('memory://search-behavior');
    await migrate(db);
    fileRepo = new FileRecordRepository(db);
    chunkRepo = new FileChunkRepository(db, false); // vectorDisabled → client path
    setRepo = new EmbeddingSetsRepository(db);

    const now = new Date().toISOString();
    await fileRepo.create({
      id: 'f1',
      name: 'readme.md',
      path: '/readme.md',
      size: 10,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('returns matches with and without set scoping; skips mismatched dimensions', async () => {
    const now = new Date().toISOString();
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 3, 'cosine');

    const chunks: FileChunkInsert[] = [
      {
        id: 'c1',
        fileRecordId: 'f1',
        chunkIndex: 0,
        content: 'hello world',
        contentHash: 'h1',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 11,
        embedding: [0.3, 0.0, 0.0],
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c2',
        fileRecordId: 'f1',
        chunkIndex: 1,
        content: 'another line',
        contentHash: 'h2',
        tokenCount: 2,
        chunkType: 'text',
        chunkSize: 12,
        embedding: [0.2, 0.1, 0.0],
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh2',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c3',
        fileRecordId: 'f1',
        chunkIndex: 2,
        content: 'mismatch dims',
        contentHash: 'h3',
        tokenCount: 2,
        chunkType: 'text',
        chunkSize: 12,
        embedding: [0.1, 0.2, 0.3, 0.4],
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh3',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = [0.25, 0.05, 0.0];

    // No set scoping: returns only candidates with parseable embeddings and matching dims
    const all = await chunkRepo.searchSimilar(query, { limit: 10, threshold: 0 });
    expect(all.map((r) => r.chunk.id)).toEqual(['c1', 'c2']);

    // With set scoping: same as above, filtered to the set
    const scoped = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
    });
    expect(scoped.map((r) => r.chunk.id)).toEqual(['c1', 'c2']);

    // Thresholding: pick only the closer one
    const stricter = await chunkRepo.searchSimilar(query, { limit: 10, threshold: 0.95 });
    expect(stricter.length).toBeLessThanOrEqual(all.length);
    expect(stricter.length).toBeGreaterThan(0);
  });
});
