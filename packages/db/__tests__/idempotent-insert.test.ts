import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileChunkInsert } from '../src/models/file-chunk';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository';
import { createDbAtVersion, LATEST_MIGRATION_VERSION } from './helpers/migrated-test-db.js';

describe('Idempotent Chunk Insertion', () => {
  let db: PGlite;
  let repository: FileChunkRepository;

  afterEach(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // A fresh in-memory database for each test, with every migration applied
    db = await createDbAtVersion(LATEST_MIGRATION_VERSION);

    repository = new FileChunkRepository(db);

    // Create file records that our chunks can reference
    await db.query(
      `
      INSERT INTO file_records (id, name, path, size, created_at, updated_at) 
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [
        'file-1',
        'test-file.txt',
        '/test/path/test-file.txt',
        1000,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
  });

  it('should handle duplicate chunk IDs gracefully with ON CONFLICT', async () => {
    const chunk: FileChunkInsert = {
      chunkIndex: 0,
      chunkSize: 16,
      chunkType: 'text',
      content: 'Original content',
      contentHash: 'original-hash',
      createdAt: new Date().toISOString(),
      embedding: undefined,
      fileRecordId: 'file-1',
      id: 'duplicate-test-chunk',
      tokenCount: 10,
      updatedAt: new Date().toISOString(),
    };

    // First insertion should work
    const first = await repository.insert(chunk);
    expect(first.id).toBe('duplicate-test-chunk');
    expect(first.content).toBe('Original content');

    // Second insertion with same ID but different content should UPDATE
    const updatedChunk: FileChunkInsert = {
      ...chunk,
      content: 'Updated content',
      contentHash: 'updated-hash',
      tokenCount: 15,
      updatedAt: new Date().toISOString(),
    };

    const second = await repository.insert(updatedChunk);
    expect(second.id).toBe('duplicate-test-chunk');
    expect(second.content).toBe('Updated content');
    expect(second.contentHash).toBe('updated-hash');
    expect(second.tokenCount).toBe(15);

    // Verify only one record exists
    const allChunks = await repository.findAll();
    expect(allChunks).toHaveLength(1);
    expect(allChunks[0].content).toBe('Updated content');
  });

  it('should handle duplicate IDs in batch insertMany', async () => {
    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 13,
        chunkType: 'text',
        content: 'First content',
        contentHash: 'hash-1',
        createdAt: new Date().toISOString(),
        embedding: undefined,
        fileRecordId: 'file-1',
        id: 'batch-duplicate-1',
        tokenCount: 10,
        updatedAt: new Date().toISOString(),
      },
      {
        chunkIndex: 1,
        chunkSize: 14,
        chunkType: 'text',
        content: 'Second content',
        contentHash: 'hash-2',
        createdAt: new Date().toISOString(),
        embedding: undefined,
        fileRecordId: 'file-1',
        id: 'batch-duplicate-2',
        tokenCount: 12,
        updatedAt: new Date().toISOString(),
      },
    ];

    // First batch insert
    const firstBatch = await repository.insertMany(chunks);
    expect(firstBatch).toHaveLength(2);

    // Second batch with same IDs but updated content
    const updatedChunks = chunks.map((chunk) => ({
      ...chunk,
      content: `${chunk.content} UPDATED`,
      contentHash: `${chunk.contentHash}-updated`,
      updatedAt: new Date().toISOString(),
    }));

    const secondBatch = await repository.insertMany(updatedChunks);
    expect(secondBatch).toHaveLength(2);
    expect(secondBatch[0].content).toContain('UPDATED');
    expect(secondBatch[1].content).toContain('UPDATED');

    // Verify only 2 records exist (no duplicates)
    const allChunks = await repository.findAll();
    expect(allChunks).toHaveLength(2);
  });
});
