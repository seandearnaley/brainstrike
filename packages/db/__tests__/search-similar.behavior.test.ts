import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { EmbeddingSetsRepository } from '../src/repositories/embedding-sets-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

function makeVector(dim: number, entries: [number, number][]): number[] {
  const vector = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    vector[idx] = value;
  }
  return vector;
}

describe('searchSimilar behavior (pgvector path)', () => {
  let db: PGlite;
  let chunkRepo: FileChunkRepository;
  let fileRepo: FileRecordRepository;
  let setRepo: EmbeddingSetsRepository;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://search-behavior');
    await migrate(db);
    fileRepo = new FileRecordRepository(db);
    chunkRepo = new FileChunkRepository(db);
    setRepo = new EmbeddingSetsRepository(db);

    const now = new Date().toISOString();
    await fileRepo.create({
      createdAt: now,
      id: 'f1',
      name: 'readme.md',
      path: '/readme.md',
      size: 10,
      updatedAt: now,
    });
    await fileRepo.create({
      createdAt: now,
      id: 'f2',
      name: 'notes.md',
      path: '/notes.md',
      size: 12,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('returns matches with and without set scoping; skips mismatched dimensions', async () => {
    const now = new Date().toISOString();
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');

    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 11,
        chunkType: 'text',
        content: 'hello world',
        contentHash: 'h1',
        createdAt: now,
        embedding: makeVector(768, [[0, 0.3]]),
        embeddingHash: 'eh1',
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'f1',
        id: 'c1',
        tokenCount: 5,
        updatedAt: now,
      },
      {
        chunkIndex: 1,
        chunkSize: 12,
        chunkType: 'text',
        content: 'another line',
        contentHash: 'h2',
        createdAt: now,
        embedding: makeVector(768, [
          [0, 0.2],
          [1, 0.1],
        ]),
        embeddingHash: 'eh2',
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'f1',
        id: 'c2',
        tokenCount: 2,
        updatedAt: now,
      },
      {
        chunkIndex: 0,
        chunkSize: 12,
        chunkType: 'text',
        content: 'notes content',
        contentHash: 'h3',
        createdAt: now,
        embedding: makeVector(768, [[1, 0.28]]),
        embeddingHash: 'eh3',
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'f2',
        id: 'c3',
        tokenCount: 4,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.25]]);

    const scoped = await chunkRepo.searchSimilar(query, {
      embeddingSetId: set.id,
      limit: 10,
      threshold: 0,
    });
    expect(scoped.map((r) => r.chunk.id)).toEqual(['c1', 'c2', 'c3']);

    // Thresholding: pick only the closer one
    const stricter = await chunkRepo.searchSimilar(query, {
      embeddingSetId: set.id,
      limit: 10,
      threshold: 0.95,
    });
    expect(stricter.map((r) => r.chunk.id)).toEqual(['c1']);
  });

  it('filters results by file path allowlist and selection snapshot', async () => {
    const now = new Date().toISOString();
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');

    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 11,
        chunkType: 'text',
        content: 'readme content',
        contentHash: 'h1',
        createdAt: now,
        embedding: makeVector(768, [[0, 0.3]]),
        embeddingHash: 'eh1',
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'f1',
        id: 'c1',
        tokenCount: 5,
        updatedAt: now,
      },
      {
        chunkIndex: 0,
        chunkSize: 10,
        chunkType: 'text',
        content: 'notes content',
        contentHash: 'h2',
        createdAt: now,
        embedding: makeVector(768, [[0, 0.25]]),
        embeddingHash: 'eh2',
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        fileRecordId: 'f2',
        id: 'c2',
        tokenCount: 4,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.2]]);

    const allowlisted = await chunkRepo.searchSimilar(query, {
      embeddingSetId: set.id,
      filePaths: ['/readme.md'],
      limit: 10,
      threshold: 0,
    });
    expect(allowlisted.map((r) => r.chunk.id)).toEqual(['c1']);

    const snapshotId = '00000000-0000-0000-0000-000000000101';
    await db.query('INSERT INTO selection_snapshots (id, created_at) VALUES ($1, $2)', [
      snapshotId,
      now,
    ]);
    await db.query(
      'INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES ($1, $2)',
      [snapshotId, '/notes.md']
    );

    const snapshotScoped = await chunkRepo.searchSimilar(query, {
      embeddingSetId: set.id,
      limit: 10,
      selectionSnapshotId: snapshotId,
      threshold: 0,
    });
    expect(snapshotScoped.map((r) => r.chunk.id)).toEqual(['c2']);
  });

  it('rejects oversized file path allowlists', async () => {
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');
    const query = makeVector(768, [[0, 0.2]]);
    const oversized = Array.from({ length: 501 }, (_, idx) => `/file-${idx}.md`);

    await expect(
      chunkRepo.searchSimilar(query, {
        embeddingSetId: set.id,
        filePaths: oversized,
        limit: 10,
        threshold: 0,
      })
    ).rejects.toThrow(/filePaths limit exceeded/);
  });
});
