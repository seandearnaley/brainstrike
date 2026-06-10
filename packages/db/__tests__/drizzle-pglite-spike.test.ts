/**
 * Drizzle + PGlite Spike Test
 *
 * Validates that Drizzle ORM works correctly with PGlite in a test environment.
 * This spike covers:
 * - Database initialization
 * - Migration execution
 * - Basic CRUD operations
 * - Vector column handling
 * - Query builder functionality
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  embeddingSets,
  fileChunks,
  fileRecords,
  jobQueue,
  type NewFileRecord,
  tokenCache,
} from '../src/schema/index.js';

describe('Drizzle + PGlite Spike', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    // Create in-memory PGlite instance with vector extension
    client = new PGlite({
      extensions: { vector },
    });

    // Initialize Drizzle with PGlite client
    db = drizzle({ client });

    // Create the vector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Run the migration SQL directly for testing
    await client.query(`
      CREATE TABLE IF NOT EXISTS "file_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" text NOT NULL,
        "path" text NOT NULL,
        "source_root_path" text,
        "size" integer NOT NULL,
        "mtime_ms" bigint,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "content" text,
        "content_hash" text,
        "token_count" integer,
        "processed_at" timestamp with time zone,
        "embedding_set_id" uuid,
        "chunks_processed_at" timestamp with time zone,
        "chunks_count" integer,
        "chunking_strategy" text
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "file_chunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "file_record_id" uuid NOT NULL REFERENCES "file_records"("id") ON DELETE CASCADE,
        "chunk_index" integer NOT NULL,
        "content" text NOT NULL,
        "content_hash" text,
        "token_count" integer,
        "chunk_type" text,
        "chunk_size" integer,
        "start_line" integer,
        "end_line" integer,
        "start_offset" integer,
        "end_offset" integer,
        "embedding" vector,
        "embedding_set_id" uuid,
        "embedding_updated_at" timestamp with time zone,
        "embedding_hash" text,
        "content_tsvector" tsvector,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "embedding_sets" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "model_key" text NOT NULL,
        "model_id" text NOT NULL,
        "dimensions" integer NOT NULL,
        "distance" text DEFAULT 'cosine',
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "name" text,
        "description" text,
        "tags" text,
        "category" text,
        "system_role" text,
        "allow_duplicates" boolean DEFAULT false
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "job_queue" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "queue" text NOT NULL,
        "job_type" text NOT NULL,
        "payload" text NOT NULL,
        "state" text DEFAULT 'queued' NOT NULL,
        "run_at" timestamp with time zone DEFAULT now() NOT NULL,
        "attempts" integer DEFAULT 0 NOT NULL,
        "max_attempts" integer DEFAULT 3 NOT NULL,
        "backoff_ms" integer DEFAULT 1000 NOT NULL,
        "lease_token" text,
        "leased_until" timestamp with time zone,
        "worker_id" text,
        "dedupe_key" text,
        "error" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "token_cache" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "file_path" text NOT NULL,
        "content_hash" text NOT NULL,
        "token_count" integer NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Database Initialization', () => {
    it('should successfully initialize Drizzle with PGlite', async () => {
      expect(db).toBeDefined();
      expect(client).toBeDefined();
    });

    it('should have vector extension available', async () => {
      const result = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'"
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.extname).toBe('vector');
    });
  });

  describe('CRUD Operations with Drizzle', () => {
    it('should insert a file record using Drizzle', async () => {
      const newRecord: NewFileRecord = {
        name: 'test.txt',
        path: '/path/to/test.txt',
        size: 1024,
      };

      const [inserted] = await db.insert(fileRecords).values(newRecord).returning();

      expect(inserted).toBeDefined();
      expect(inserted?.name).toBe('test.txt');
      expect(inserted?.path).toBe('/path/to/test.txt');
      expect(inserted?.size).toBe(1024);
      expect(inserted?.id).toBeDefined();
    });

    it('should select file records using Drizzle', async () => {
      // Insert test data
      await db.insert(fileRecords).values([
        { name: 'file1.txt', path: '/file1.txt', size: 100 },
        { name: 'file2.txt', path: '/file2.txt', size: 200 },
      ]);

      const records = await db.select().from(fileRecords);
      expect(records).toHaveLength(2);
    });

    it('should update a file record using Drizzle', async () => {
      const [inserted] = await db
        .insert(fileRecords)
        .values({
          name: 'original.txt',
          path: '/original.txt',
          size: 100,
        })
        .returning();

      const [updated] = await db
        .update(fileRecords)
        .set({ name: 'updated.txt', size: 200 })
        .where(eq(fileRecords.id, inserted!.id))
        .returning();

      expect(updated?.name).toBe('updated.txt');
      expect(updated?.size).toBe(200);
    });

    it('should delete a file record using Drizzle', async () => {
      const [inserted] = await db
        .insert(fileRecords)
        .values({
          name: 'to-delete.txt',
          path: '/to-delete.txt',
          size: 100,
        })
        .returning();

      await db.delete(fileRecords).where(eq(fileRecords.id, inserted!.id));

      const remaining = await db.select().from(fileRecords).where(eq(fileRecords.id, inserted!.id));
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Vector Column Handling', () => {
    it('should insert and retrieve vector embeddings using parameterized queries', async () => {
      // First create a file record
      const [fileRecord] = await db
        .insert(fileRecords)
        .values({
          name: 'test.txt',
          path: '/test.txt',
          size: 100,
        })
        .returning();

      // Insert a chunk with embedding using parameterized query
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const embeddingStr = `[${embedding.join(',')}]`;

      await client.query(
        `INSERT INTO file_chunks (file_record_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4::vector)`,
        [fileRecord!.id, 0, 'test content', embeddingStr]
      );

      // Retrieve using Drizzle
      const chunks = await db.select().from(fileChunks);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toBe('test content');
    });

    it('should perform vector similarity search with parameterized queries', async () => {
      // Create file record
      const [fileRecord] = await db
        .insert(fileRecords)
        .values({
          name: 'test.txt',
          path: '/test.txt',
          size: 100,
        })
        .returning();

      // Insert multiple chunks with embeddings using parameterized queries
      const embeddings = [
        [0.1, 0.2, 0.3, 0.4, 0.5],
        [0.9, 0.8, 0.7, 0.6, 0.5],
        [0.11, 0.21, 0.31, 0.41, 0.51], // Similar to first
      ];

      for (let i = 0; i < embeddings.length; i++) {
        const emb = embeddings[i];
        const embStr = `[${emb!.join(',')}]`;
        await client.query(
          `INSERT INTO file_chunks (file_record_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4::vector)`,
          [fileRecord!.id, i, `content ${i}`, embStr]
        );
      }

      // Perform similarity search using parameterized query
      const queryEmbedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const queryEmbStr = `[${queryEmbedding.join(',')}]`;

      const results = await client.query<{ content: string; distance: number }>(
        `SELECT id, content, embedding <=> $1::vector AS distance
         FROM file_chunks
         ORDER BY distance ASC
         LIMIT 2`,
        [queryEmbStr]
      );

      expect(results.rows).toHaveLength(2);
      // First result should be the exact match or very close
      expect(results.rows[0]?.content).toBe('content 0');
    });
  });

  describe('Query Builder Features', () => {
    it('should support toSQL() for live query integration', async () => {
      // This is critical for the live query wrapper approach
      const query = db.select().from(fileRecords).where(eq(fileRecords.size, 100));

      const { sql: sqlQuery, params } = query.toSQL();

      expect(sqlQuery.toLowerCase()).toContain('select');
      expect(sqlQuery).toContain('file_records');
      expect(sqlQuery).toContain('size');
      expect(params).toContain(100);
    });

    it('should support parameterized queries with sql template', async () => {
      await db.insert(fileRecords).values([
        { name: 'small.txt', path: '/small.txt', size: 50 },
        { name: 'medium.txt', path: '/medium.txt', size: 100 },
        { name: 'large.txt', path: '/large.txt', size: 200 },
      ]);

      const minSize = 100;
      const results = await db
        .select()
        .from(fileRecords)
        .where(sql`${fileRecords.size} >= ${minSize}`);

      expect(results).toHaveLength(2);
    });
  });

  describe('Foreign Key Relationships', () => {
    it('should cascade delete chunks when file record is deleted', async () => {
      // Create file record
      const [fileRecord] = await db
        .insert(fileRecords)
        .values({
          name: 'test.txt',
          path: '/test.txt',
          size: 100,
        })
        .returning();

      // Create chunks using parameterized query
      await client.query(
        `INSERT INTO file_chunks (file_record_id, chunk_index, content)
         VALUES ($1, $2, $3), ($1, $4, $5)`,
        [fileRecord!.id, 0, 'chunk 0', 1, 'chunk 1']
      );

      // Verify chunks exist
      let chunks = await db.select().from(fileChunks);
      expect(chunks).toHaveLength(2);

      // Delete file record
      await db.delete(fileRecords).where(eq(fileRecords.id, fileRecord!.id));

      // Verify chunks were cascade deleted
      chunks = await db.select().from(fileChunks);
      expect(chunks).toHaveLength(0);
    });
  });

  describe('Job Queue Operations', () => {
    it('should insert and query job queue entries', async () => {
      await db.insert(jobQueue).values({
        queue: 'embeddings',
        jobType: 'generate_embedding',
        payload: JSON.stringify({ fileId: '123' }),
        state: 'queued',
      });

      const jobs = await db.select().from(jobQueue).where(eq(jobQueue.state, 'queued'));

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.queue).toBe('embeddings');
      expect(JSON.parse(jobs[0]!.payload)).toEqual({ fileId: '123' });
    });
  });

  describe('Embedding Sets Operations', () => {
    it('should create and query embedding sets', async () => {
      await db.insert(embeddingSets).values({
        modelKey: 'openai-ada-002',
        modelId: 'text-embedding-ada-002',
        dimensions: 1536,
        distance: 'cosine',
        name: 'OpenAI Ada 002',
      });

      const sets = await db.select().from(embeddingSets);
      expect(sets).toHaveLength(1);
      expect(sets[0]?.dimensions).toBe(1536);
      expect(sets[0]?.distance).toBe('cosine');
      expect(sets[0]?.systemRole).toBeNull();
    });
  });

  describe('Token Cache Operations', () => {
    it('should insert and query token cache entries', async () => {
      await db.insert(tokenCache).values({
        filePath: '/path/to/file.txt',
        contentHash: 'abc123',
        tokenCount: 500,
      });

      const entries = await db
        .select()
        .from(tokenCache)
        .where(eq(tokenCache.contentHash, 'abc123'));

      expect(entries).toHaveLength(1);
      expect(entries[0]?.tokenCount).toBe(500);
    });
  });
});
