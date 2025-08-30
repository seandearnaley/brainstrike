import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert, FileChunkUpdate } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';

describe('FileChunkRepository', () => {
  let db: PGlite;
  let repository: FileChunkRepository;
  let fileRepository: FileRecordRepository;

  beforeEach(async () => {
    // Create a fresh in-memory database for each test
    db = new PGlite();
    await migrate(db);
    repository = new FileChunkRepository(db, false);
    fileRepository = new FileRecordRepository(db);

    // Create test file records that chunks can reference
    await fileRepository.create({
      id: 'file1',
      name: 'test1.txt',
      path: '/test1.txt',
      content: 'Test file 1 content',
      mimeType: 'text/plain',
      size: 19,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await fileRepository.create({
      id: 'file2',
      name: 'test2.txt',
      path: '/test2.txt',
      content: 'Test file 2 content',
      mimeType: 'text/plain',
      size: 19,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe('insert', () => {
    it('should insert a new file chunk', async () => {
      const chunk: FileChunkInsert = {
        id: 'chunk1',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'This is a test chunk.',
        contentHash: 'hash123',
        tokenCount: 5,
        chunkType: 'text',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);

      const result = await repository.findById('chunk1');
      expect(result).toBeDefined();
      expect(result?.id).toBe('chunk1');
      expect(result?.content).toBe('This is a test chunk.');
      expect(result?.fileRecordId).toBe('file1');
      expect(result?.chunkIndex).toBe(0);
      expect(result?.tokenCount).toBe(5);
      expect(result?.chunkType).toBe('text');
    });

    it('should insert a chunk with embedding', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const chunk: FileChunkInsert = {
        id: 'chunk2',
        fileRecordId: 'file1',
        chunkIndex: 1,
        content: 'Another test chunk.',
        contentHash: 'hash456',
        tokenCount: 4,
        chunkType: 'sentence',
        chunkSize: 100,
        embedding,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);

      const result = await repository.findById('chunk2');
      expect(result).toBeDefined();
      expect(result?.embedding).toEqual(embedding);
    });
  });

  describe('insertMany', () => {
    it('should insert multiple chunks', async () => {
      const chunks: FileChunkInsert[] = [
        {
          id: 'chunk1',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'First chunk',
          contentHash: 'hash1',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk2',
          fileRecordId: 'file1',
          chunkIndex: 1,
          content: 'Second chunk',
          contentHash: 'hash2',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      await repository.insertMany(chunks);

      const result1 = await repository.findById('chunk1');
      const result2 = await repository.findById('chunk2');

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1?.content).toBe('First chunk');
      expect(result2?.content).toBe('Second chunk');
    });

    it('should handle empty array', async () => {
      await expect(repository.insertMany([])).resolves.not.toThrow();
    });
  });

  describe('findById', () => {
    it('should return null for non-existent chunk', async () => {
      const result = await repository.findById('nonexistent');
      expect(result).toBeNull();
    });

    it('should find chunk by id', async () => {
      const chunk: FileChunkInsert = {
        id: 'findme',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'Find this chunk',
        contentHash: 'hash123',
        tokenCount: 3,
        chunkType: 'recursive',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);
      const result = await repository.findById('findme');

      expect(result).toBeDefined();
      expect(result?.id).toBe('findme');
      expect(result?.content).toBe('Find this chunk');
    });
  });

  describe('findByFileRecordId', () => {
    it('should return empty array for file with no chunks', async () => {
      const result = await repository.findByFileRecordId('nonexistent');
      expect(result).toEqual([]);
    });

    it('should find all chunks for a file record', async () => {
      const chunks: FileChunkInsert[] = [
        {
          id: 'chunk1',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'First chunk',
          contentHash: 'hash1',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk2',
          fileRecordId: 'file1',
          chunkIndex: 1,
          content: 'Second chunk',
          contentHash: 'hash2',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk3',
          fileRecordId: 'file2',
          chunkIndex: 0,
          content: 'Different file chunk',
          contentHash: 'hash3',
          tokenCount: 3,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      await repository.insertMany(chunks);

      const result = await repository.findByFileRecordId('file1');
      expect(result).toHaveLength(2);
      expect(result[0].chunkIndex).toBe(0);
      expect(result[1].chunkIndex).toBe(1);
      expect(result.every((chunk) => chunk.fileRecordId === 'file1')).toBe(true);
    });

    it('should return chunks in order by chunk index', async () => {
      const chunks: FileChunkInsert[] = [
        {
          id: 'chunk2',
          fileRecordId: 'file1',
          chunkIndex: 1,
          content: 'Second chunk',
          contentHash: 'hash2',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk1',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'First chunk',
          contentHash: 'hash1',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      await repository.insertMany(chunks);

      const result = await repository.findByFileRecordId('file1');
      expect(result).toHaveLength(2);
      expect(result[0].chunkIndex).toBe(0);
      expect(result[1].chunkIndex).toBe(1);
      expect(result[0].content).toBe('First chunk');
      expect(result[1].content).toBe('Second chunk');
    });
  });

  describe('update', () => {
    it('should update chunk content and properties', async () => {
      // First insert a chunk
      const chunk: FileChunkInsert = {
        id: 'updateme',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'Original content',
        contentHash: 'original_hash',
        tokenCount: 2,
        chunkType: 'text',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);

      // Now update it
      const updateData: FileChunkUpdate = {
        id: 'updateme',
        content: 'Updated content',
        contentHash: 'updated_hash',
        tokenCount: 3,
        updatedAt: new Date().toISOString(),
      };

      await repository.update(updateData);

      const result = await repository.findById('updateme');
      expect(result).toBeDefined();
      expect(result?.content).toBe('Updated content');
      expect(result?.contentHash).toBe('updated_hash');
      expect(result?.tokenCount).toBe(3);
      expect(result?.chunkType).toBe('text'); // Should remain unchanged
    });

    it('should update embedding', async () => {
      const chunk: FileChunkInsert = {
        id: 'embedme',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'Content to embed',
        contentHash: 'hash123',
        tokenCount: 3,
        chunkType: 'text',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);

      const embedding = [0.5, 0.6, 0.7];
      const updateData: FileChunkUpdate = {
        id: 'embedme',
        embedding,
        updatedAt: new Date().toISOString(),
      };

      await repository.update(updateData);

      const result = await repository.findById('embedme');
      expect(result?.embedding).toEqual(embedding);
    });
  });

  describe('deleteByFileRecordId', () => {
    it('should delete all chunks for a file record', async () => {
      const chunks: FileChunkInsert[] = [
        {
          id: 'chunk1',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'First chunk',
          contentHash: 'hash1',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk2',
          fileRecordId: 'file1',
          chunkIndex: 1,
          content: 'Second chunk',
          contentHash: 'hash2',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'chunk3',
          fileRecordId: 'file2',
          chunkIndex: 0,
          content: 'Different file chunk',
          contentHash: 'hash3',
          tokenCount: 3,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      await repository.insertMany(chunks);

      // Delete chunks for file1
      await repository.deleteByFileRecordId('file1');

      // Should have deleted file1 chunks but not file2
      const file1Chunks = await repository.findByFileRecordId('file1');
      const file2Chunks = await repository.findByFileRecordId('file2');

      expect(file1Chunks).toHaveLength(0);
      expect(file2Chunks).toHaveLength(1);
      expect(file2Chunks[0].content).toBe('Different file chunk');
    });

    it('should handle deletion of non-existent file record', async () => {
      await expect(repository.deleteByFileRecordId('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('embedding parsing', () => {
    it('should handle null embedding', async () => {
      const chunk: FileChunkInsert = {
        id: 'no_embedding',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'No embedding',
        contentHash: 'hash123',
        tokenCount: 2,
        chunkType: 'text',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);
      const result = await repository.findById('no_embedding');

      expect(result?.embedding).toBeUndefined();
    });

    it('should handle empty string embedding', async () => {
      // Insert raw data that would have empty embedding string
      await db.query(
        `INSERT INTO file_chunks (
          id, file_record_id, chunk_index, content, content_hash, 
          token_count, chunk_type, chunk_size, embedding, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          'empty_embedding',
          'file1',
          0,
          'Empty embedding test',
          'hash123',
          3,
          'text',
          100,
          '', // Empty string
          new Date().toISOString(),
          new Date().toISOString(),
        ]
      );

      const result = await repository.findById('empty_embedding');
      expect(result?.embedding).toBeUndefined();
    });

    it('should handle invalid JSON embedding gracefully', async () => {
      // Insert raw data with invalid JSON
      await db.query(
        `INSERT INTO file_chunks (
          id, file_record_id, chunk_index, content, content_hash, 
          token_count, chunk_type, chunk_size, embedding, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          'invalid_embedding',
          'file1',
          0,
          'Invalid embedding test',
          'hash123',
          3,
          'text',
          100,
          '{invalid json}',
          new Date().toISOString(),
          new Date().toISOString(),
        ]
      );

      const result = await repository.findById('invalid_embedding');
      expect(result?.embedding).toBeUndefined();
    });
  });
});
