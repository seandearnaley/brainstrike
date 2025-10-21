import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert, FileChunkUpdate } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

function makeVector(dim: number, entries: Array<[number, number]>): number[] {
  const vector = new Array(dim).fill(0);
  for (const [idx, value] of entries) {
    vector[idx] = value;
  }
  return vector;
}

describe('FileChunkRepository', () => {
  let db: PGlite;
  let repository: FileChunkRepository;
  let fileRepository: FileRecordRepository;

  beforeEach(async () => {
    // Create a fresh in-memory database for each test
    db = await wasmLoader.createPGlite('memory://file-chunk-repo');
    await migrate(db);
    repository = new FileChunkRepository(db);
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
      const embedding = makeVector(768, [
        [0, 0.1],
        [1, 0.2],
        [2, 0.3],
        [3, 0.4],
        [4, 0.5],
      ]);
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

      const embedding = makeVector(768, [
        [0, 0.5],
        [1, 0.6],
        [2, 0.7],
      ]);
      const updateData: FileChunkUpdate = {
        id: 'embedme',
        embedding,
        updatedAt: new Date().toISOString(),
      };

      await repository.update(updateData);

      const result = await repository.findById('embedme');
      expect(result?.embedding).toEqual(embedding);
    });

    it('rejects embedding updates that exceed the pgvector maximum dimension', async () => {
      const chunk: FileChunkInsert = {
        id: 'embedme-too-large',
        fileRecordId: 'file1',
        chunkIndex: 0,
        content: 'Content to embed (max check)',
        contentHash: 'hash-max-check',
        tokenCount: 3,
        chunkType: 'text',
        chunkSize: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await repository.insert(chunk);

      const embedding = makeVector(16_001, [
        [0, 0.4],
        [16_000, 0.6],
      ]);
      const updateData: FileChunkUpdate = {
        id: 'embedme-too-large',
        embedding,
        updatedAt: new Date().toISOString(),
      };

      await expect(repository.update(updateData)).rejects.toThrow(
        /Embedding dimension 16001 exceeds pgvector's supported maximum of 16000/
      );
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

    it('should persist embeddings stored as vector columns', async () => {
      const embedding = makeVector(768, [
        [0, 0.11],
        [10, 0.22],
      ]);
      await db.query(
        `INSERT INTO file_chunks (
          id, file_record_id, chunk_index, content, content_hash,
          token_count, chunk_type, chunk_size, embedding, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          'vector_embedding',
          'file1',
          1,
          'Vector embedding test',
          'hashV',
          3,
          'text',
          100,
          `[${embedding.join(',')}]`,
          new Date().toISOString(),
          new Date().toISOString(),
        ]
      );

      const result = await repository.findById('vector_embedding');
      expect(result?.embedding).toEqual(embedding);
    });
  });

  describe('embedding dimension validation', () => {
    describe('insert', () => {
      it('rejects embeddings that do not align with their embedding set dimension', async () => {
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','test-model','test-model',768,'cosine',CURRENT_TIMESTAMP)`
        );

        const embedding = makeVector(384, [
          [0, 0.1],
          [1, 0.2],
        ]);
        const chunk: FileChunkInsert = {
          id: 'chunk_384d',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash384',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          embedding,
          embeddingSetId: 'set-768',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await expect(repository.insert(chunk)).rejects.toThrow(
          /Embedding dimension mismatch: received 384, expected 768/
        );
      });

      it('accepts embeddings that match the embedding set dimension', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-1024','test-model-1024','test-model-1024',1024,'cosine',$1)`,
          [now]
        );

        const embedding = makeVector(1024, [
          [0, 0.1],
          [1, 0.2],
        ]);
        const chunk: FileChunkInsert = {
          id: 'chunk_1024d',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash1024',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          embedding,
          embeddingSetId: 'set-1024',
          createdAt: now,
          updatedAt: now,
        };

        const inserted = await repository.insert(chunk);
        expect(inserted.embedding?.length).toBe(1024);
        expect(inserted.embeddingSetId).toBe('set-1024');
      });

      it('should accept 768D embeddings', async () => {
        const embedding = makeVector(768, [
          [0, 0.1],
          [1, 0.2],
          [767, 0.3],
        ]);
        const chunk: FileChunkInsert = {
          id: 'chunk_768d',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash768',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          embedding,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await repository.insert(chunk);
        expect(result).toBeDefined();
        expect(result.embedding).toEqual(embedding);
      });

      it('rejects embeddings exceeding the pgvector maximum dimension', async () => {
        const embedding = makeVector(16_001, [
          [0, 0.25],
          [16_000, 0.75],
        ]);
        const chunk: FileChunkInsert = {
          id: 'chunk_exceeds_max_dim',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'High-dimension chunk',
          contentHash: 'hash_max_dim',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          embedding,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await expect(repository.insert(chunk)).rejects.toThrow(
          /Embedding dimension 16001 exceeds pgvector's supported maximum of 16000/
        );
      });

      it('should accept null/undefined embeddings', async () => {
        const chunk: FileChunkInsert = {
          id: 'chunk_no_embedding',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash_no_emb',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await repository.insert(chunk);
        expect(result).toBeDefined();
        expect(result.embedding).toBeUndefined();
      });
    });

    describe('insertMany', () => {
      it('should reject batches containing non-768D embeddings', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','batch-model','batch-model',768,'cosine',$1)`,
          [now]
        );

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
            embedding: makeVector(768, [[0, 0.1]]),
            embeddingSetId: 'set-768',
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
            embedding: makeVector(384, [[0, 0.2]]), // Invalid!
            embeddingSetId: 'set-768',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];

        await expect(repository.insertMany(chunks)).rejects.toThrow(
          /Embedding dimension mismatch: received 384, expected 768/
        );

        // Verify no partial writes occurred
        const result1 = await repository.findById('chunk1');
        const result2 = await repository.findById('chunk2');
        expect(result1).toBeNull();
        expect(result2).toBeNull();
      });

      it('should accept batches with all 768D embeddings', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','batch-model','batch-model',768,'cosine',$1)
           ON CONFLICT (id) DO NOTHING`,
          [now]
        );

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
            embedding: makeVector(768, [
              [0, 0.1],
              [1, 0.2],
            ]),
            embeddingSetId: 'set-768',
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
            embedding: makeVector(768, [
              [0, 0.3],
              [1, 0.4],
            ]),
            embeddingSetId: 'set-768',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];

        const results = await repository.insertMany(chunks);
        expect(results).toHaveLength(2);
        expect(results[0].embedding).toHaveLength(768);
        expect(results[1].embedding).toHaveLength(768);
      });
    });

    describe('insertManyWithTx', () => {
      it('should reject batches with non-768D embeddings in transaction', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','tx-model','tx-model',768,'cosine',$1)`,
          [now]
        );

        const chunks: FileChunkInsert[] = [
          {
            id: 'chunk_tx_1',
            fileRecordId: 'file1',
            chunkIndex: 0,
            content: 'First chunk',
            contentHash: 'hash_tx1',
            tokenCount: 2,
            chunkType: 'text',
            chunkSize: 100,
            embedding: makeVector(1024, [[0, 0.1]]), // Invalid!
            embeddingSetId: 'set-768',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];

        // Begin transaction manually
        await db.query('BEGIN');
        try {
          await expect(repository.insertManyWithTx(db, chunks)).rejects.toThrow(
            /Embedding dimension mismatch: received 1024, expected 768/
          );
          await db.query('ROLLBACK');
        } catch (err) {
          await db.query('ROLLBACK');
          throw err;
        }

        // Verify no data was written
        const result = await repository.findById('chunk_tx_1');
        expect(result).toBeNull();
      });
    });

    describe('update', () => {
      it('should reject updates with non-768D embeddings', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','update-model','update-model',768,'cosine',$1)`,
          [now]
        );

        // First insert a chunk without embedding
        const chunk: FileChunkInsert = {
          id: 'chunk_update_test',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash_update',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await repository.insert(chunk);

        // Try to update with 384D embedding
        const update: FileChunkUpdate = {
          id: 'chunk_update_test',
          embedding: makeVector(384, [[0, 0.1]]),
          embeddingSetId: 'set-768',
          updatedAt: new Date().toISOString(),
        };

        await expect(repository.update(update)).rejects.toThrow(
          /Embedding dimension mismatch: received 384, expected 768/
        );
      });

      it('should accept updates with 768D embeddings', async () => {
        const now = new Date().toISOString();
        await db.query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
           VALUES ('set-768','update-model','update-model',768,'cosine',$1)
           ON CONFLICT (id) DO NOTHING`,
          [now]
        );

        // First insert a chunk without embedding
        const chunk: FileChunkInsert = {
          id: 'chunk_update_success',
          fileRecordId: 'file1',
          chunkIndex: 0,
          content: 'Test chunk',
          contentHash: 'hash_update_ok',
          tokenCount: 2,
          chunkType: 'text',
          chunkSize: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await repository.insert(chunk);

        // Update with valid 768D embedding
        const embedding = makeVector(768, [
          [0, 0.5],
          [1, 0.6],
        ]);
        const update: FileChunkUpdate = {
          id: 'chunk_update_success',
          embedding,
          embeddingSetId: 'set-768',
          updatedAt: new Date().toISOString(),
        };

        const result = await repository.update(update);
        expect(result).toBeDefined();
        expect(result?.embedding).toEqual(embedding);
      });
    });
  });
});
