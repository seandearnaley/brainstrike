import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrations } from '../src/migrations';
import { MigrationRunner } from '../src/migrations/migration-runner';
import type { FileChunkInsert } from '../src/models/file-chunk';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository';
import { FileRecordRepository } from '../src/repositories/file-record-repository';
import { wasmLoader } from '../src/wasm-loader';

function makeVector(dim: number, entries: [number, number][]): number[] {
  const vector = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    vector[idx] = value;
  }
  return vector;
}

describe('Batched insertMany', () => {
  let db: PGlite;
  let repository: FileChunkRepository;
  let _fileRecordRepository: FileRecordRepository;

  beforeEach(async () => {
    // Create a fresh in-memory database for each test
    db = await wasmLoader.createPGlite('memory://batch-insert');

    // Run all migrations to set up the schema
    const migrationRunner = new MigrationRunner(db);
    await migrationRunner.initialize();
    await migrationRunner.up(migrations);

    repository = new FileChunkRepository(db);
    _fileRecordRepository = new FileRecordRepository(db);

    // Create file records that our chunks can reference
    // Use direct SQL insertion to avoid repository complexities
    await db.query(
      `
      INSERT INTO file_records (id, name, path, size, created_at, updated_at) 
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [
        'file-1',
        'test-file-1.txt',
        '/test/path/test-file-1.txt',
        1000,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
  });

  it('should batch large inserts into chunks of 250', async () => {
    // Create 600 test chunks
    const chunks: FileChunkInsert[] = Array.from({ length: 600 }, (_, i) => ({
      chunkIndex: i,
      chunkSize: 100,
      chunkType: 'text' as const,
      content: `Content ${i}`,
      contentHash: `hash-${i}`,
      createdAt: new Date().toISOString(),
      embedding: undefined,
      fileRecordId: 'file-1',
      id: `chunk-${i}`,
      tokenCount: 100,
      updatedAt: new Date().toISOString(),
    }));

    // Spy on db.query to count the number of INSERT queries
    const querySpy = vi.spyOn(db, 'query');

    // Insert all chunks
    const result = await repository.insertMany(chunks);

    // Should return all chunks
    expect(result).toHaveLength(600);

    // Count INSERT queries (excluding BEGIN/COMMIT/ROLLBACK)
    const insertQueries = querySpy.mock.calls.filter((call) =>
      call[0].includes('INSERT INTO file_chunks')
    );

    // Should have made 3 INSERT queries (600 / 250 = 3 batches)
    expect(insertQueries).toHaveLength(3);

    // Verify all chunks were inserted
    const allChunks = await repository.findAll();
    expect(allChunks).toHaveLength(600);
  });

  it('should handle empty array', async () => {
    const result = await repository.insertMany([]);
    expect(result).toEqual([]);
  });

  it('should handle single chunk', async () => {
    const chunk: FileChunkInsert = {
      chunkIndex: 0,
      chunkSize: 12,
      chunkType: 'text',
      content: 'Test content',
      contentHash: 'hash-1',
      createdAt: new Date().toISOString(),
      embedding: undefined,
      fileRecordId: 'file-1',
      id: 'chunk-1',
      tokenCount: 10,
      updatedAt: new Date().toISOString(),
    };

    const result = await repository.insertMany([chunk]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('chunk-1');
  });

  it('should maintain transaction integrity on error', async () => {
    // Create chunks with one duplicate that will cause an error
    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 100,
        chunkType: 'text',
        content: 'Content 1',
        contentHash: 'hash-1',
        createdAt: new Date().toISOString(),
        embedding: undefined,
        fileRecordId: 'file-1',
        id: 'chunk-1',
        tokenCount: 100,
        updatedAt: new Date().toISOString(),
      },
      {
        chunkIndex: 1,
        chunkSize: 100,
        chunkType: 'text',
        content: 'Content 2',
        contentHash: 'hash-2',
        createdAt: new Date().toISOString(),
        embedding: undefined,
        fileRecordId: 'file-1',
        id: 'chunk-1', // Duplicate ID will cause error
        tokenCount: 100,
        updatedAt: new Date().toISOString(),
      },
    ];

    // Should throw an error due to duplicate ID
    await expect(repository.insertMany(chunks)).rejects.toThrow();

    // Verify no chunks were inserted (transaction rolled back)
    const allChunks = await repository.findAll();
    expect(allChunks).toHaveLength(0);
  });

  it('should handle embeddings in batch insert', async () => {
    const embedding = makeVector(768, [
      [0, 0.1],
      [1, 0.2],
      [2, 0.3],
    ]);
    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 100,
        chunkType: 'text',
        content: 'Content with embedding',
        contentHash: 'hash-1',
        createdAt: new Date().toISOString(),
        embedding,
        fileRecordId: 'file-1',
        id: 'chunk-1',
        tokenCount: 100,
        updatedAt: new Date().toISOString(),
      },
    ];

    const result = await repository.insertMany(chunks);
    expect(result).toHaveLength(1);
    expect(result[0].embedding).toEqual(embedding);
  });

  it('rejects embeddings that exceed the pgvector maximum dimension', async () => {
    const chunks: FileChunkInsert[] = [
      {
        chunkIndex: 0,
        chunkSize: 100,
        chunkType: 'text',
        content: 'High dimension embedding',
        contentHash: 'hash-too-large',
        createdAt: new Date().toISOString(),
        embedding: makeVector(16_001, [
          [0, 0.1],
          [16_000, 0.2],
        ]),
        fileRecordId: 'file-1',
        id: 'chunk-too-large',
        tokenCount: 100,
        updatedAt: new Date().toISOString(),
      },
    ];

    await expect(repository.insertMany(chunks)).rejects.toThrow(
      /Embedding dimension 16001 exceeds pgvector's supported maximum of 2000/
    );
  });
});
