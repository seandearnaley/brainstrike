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
      id: 'f1',
      name: 'readme.md',
      path: '/readme.md',
      size: 10,
      createdAt: now,
      updatedAt: now,
    });
    await fileRepo.create({
      id: 'f2',
      name: 'notes.md',
      path: '/notes.md',
      size: 12,
      createdAt: now,
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
        id: 'c1',
        fileRecordId: 'f1',
        chunkIndex: 0,
        content: 'hello world',
        contentHash: 'h1',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 11,
        embedding: makeVector(768, [[0, 0.3]]),
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
        embedding: makeVector(768, [
          [0, 0.2],
          [1, 0.1],
        ]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh2',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c3',
        fileRecordId: 'f2',
        chunkIndex: 0,
        content: 'notes content',
        contentHash: 'h3',
        tokenCount: 4,
        chunkType: 'text',
        chunkSize: 12,
        embedding: makeVector(768, [[1, 0.28]]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh3',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.25]]);

    const scoped = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
    });
    expect(scoped.map((r) => r.chunk.id)).toEqual(['c1', 'c2', 'c3']);

    // Thresholding: pick only the closer one
    const stricter = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0.95,
      embeddingSetId: set.id,
    });
    expect(stricter.map((r) => r.chunk.id)).toEqual(['c1']);
  });

  it('filters results by file path allowlist and selection snapshot', async () => {
    const now = new Date().toISOString();
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');

    const chunks: FileChunkInsert[] = [
      {
        id: 'c1',
        fileRecordId: 'f1',
        chunkIndex: 0,
        content: 'readme content',
        contentHash: 'h1',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 11,
        embedding: makeVector(768, [[0, 0.3]]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'c2',
        fileRecordId: 'f2',
        chunkIndex: 0,
        content: 'notes content',
        contentHash: 'h2',
        tokenCount: 4,
        chunkType: 'text',
        chunkSize: 10,
        embedding: makeVector(768, [[0, 0.25]]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'eh2',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.2]]);

    const allowlisted = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
      filePaths: ['/readme.md'],
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
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
      selectionSnapshotId: snapshotId,
    });
    expect(snapshotScoped.map((r) => r.chunk.id)).toEqual(['c2']);
  });

  it('filters duplicate relative paths by root-aware allowlist and selection snapshot entries', async () => {
    const now = new Date().toISOString();
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');

    await db.query(
      `INSERT INTO roots (id, kind, display_name, path, status)
       VALUES ($1, 'path', 'Repo A', '/repo-a', 'live'), ($2, 'path', 'Repo B', '/repo-b', 'live')`,
      ['root-a', 'root-b']
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
       VALUES ($1, 'shared.ts', '/src/shared.ts', $2, 10, $5, $5),
              ($3, 'shared.ts', '/src/shared.ts', $4, 10, $5, $5)`,
      ['fr-root-a', 'root-a', 'fr-root-b', 'root-b', now]
    );

    const chunks: FileChunkInsert[] = [
      {
        id: 'chunk-root-a',
        fileRecordId: 'fr-root-a',
        chunkIndex: 0,
        content: 'root a shared file',
        contentHash: 'root-a-hash',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 18,
        embedding: makeVector(768, [[0, 0.3]]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'root-a-embedding',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'chunk-root-b',
        fileRecordId: 'fr-root-b',
        chunkIndex: 0,
        content: 'root b shared file',
        contentHash: 'root-b-hash',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 18,
        embedding: makeVector(768, [[0, 0.28]]),
        embeddingSetId: set.id,
        embeddingUpdatedAt: now,
        embeddingHash: 'root-b-embedding',
        createdAt: now,
        updatedAt: now,
      },
    ];
    await chunkRepo.insertMany(chunks);

    const query = makeVector(768, [[0, 0.2]]);
    const allowlisted = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
      filePaths: ['/src/shared.ts'],
      rootId: 'root-a',
    });
    expect(allowlisted.map((r) => r.chunk.id)).toEqual(['chunk-root-a']);

    const snapshotId = '00000000-0000-0000-0000-000000000102';
    await db.query('INSERT INTO selection_snapshots (id, created_at) VALUES ($1, $2)', [
      snapshotId,
      now,
    ]);
    await db.query(
      'INSERT INTO selection_snapshot_files (snapshot_id, file_path, root_id) VALUES ($1, $2, $3)',
      [snapshotId, '/src/shared.ts', 'root-b']
    );

    const snapshotScoped = await chunkRepo.searchSimilar(query, {
      limit: 10,
      threshold: 0,
      embeddingSetId: set.id,
      selectionSnapshotId: snapshotId,
    });
    expect(snapshotScoped.map((r) => r.chunk.id)).toEqual(['chunk-root-b']);
  });

  it('rejects oversized file path allowlists', async () => {
    const set = await setRepo.getOrCreateSet('jina-code', 'Xenova/jina-code', 768, 'cosine');
    const query = makeVector(768, [[0, 0.2]]);
    const oversized = Array.from({ length: 501 }, (_, idx) => `/file-${idx}.md`);

    await expect(
      chunkRepo.searchSimilar(query, {
        limit: 10,
        threshold: 0,
        embeddingSetId: set.id,
        filePaths: oversized,
      })
    ).rejects.toThrow(/filePaths limit exceeded/);
  });
});
