/**
 * tsvector Generated Column Integration Tests
 *
 * content_tsvector is a STORED generated column (computed by Postgres from
 * `content`), replacing the previous trigger / explicit `to_tsvector()` in every
 * INSERT. This test proves the column is generated and that a repository insert
 * which does NOT set content_tsvector still produces a full-text-searchable row.
 *
 * Run with: TEST_ENABLE_VECTOR=true pnpm test tsvector-generated-column.integration.test.ts
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('content_tsvector generated column (integration)', () => {
  it('defines content_tsvector as a STORED generated column', async () => {
    const db: PGlite = await createMigratedTestDb();

    const res = await db.query(
      `SELECT attgenerated
         FROM pg_attribute
        WHERE attrelid = 'file_chunks'::regclass
          AND attname = 'content_tsvector'`
    );
    const row = res.rows[0] as { attgenerated: string } | undefined;
    // 's' = STORED generated column; '' = a plain (non-generated) column.
    expect(row?.attgenerated).toBe('s');

    await db.close();
  });

  it('auto-populates content_tsvector on insert without the repo setting it', async () => {
    const db: PGlite = await createMigratedTestDb();

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['f1', 'file.txt', '/tmp/file.txt', 1, now, now]
    );

    const repo = new FileChunkRepository(db);
    const chunk: FileChunkInsert = {
      chunkIndex: 0,
      chunkSize: 43,
      chunkType: 'text',
      content: 'the quick brown fox jumps over the lazy dog',
      contentHash: 'h1',
      createdAt: now,
      endLine: 1,
      endOffset: 43,
      fileRecordId: 'f1',
      id: 'c1',
      startLine: 1,
      startOffset: 0,
      tokenCount: 9,
      updatedAt: now,
    };
    await repo.insertMany([chunk]);

    // The repo never set content_tsvector — the generated column must have
    // computed it so full-text search finds the row.
    const results = await repo.fullTextSearch('quick fox', {
      limit: 10,
      threshold: 0,
    });
    expect(results.map((r) => r.chunk.id)).toContain('c1');

    await db.close();
  });

  // The production bug this migration fixes — the drizzle manifest creating a
  // PLAIN content_tsvector with no GIN index — lives on the drizzle `runMigrations`
  // path, NOT the numbered `migrate()` bootstrap above. The other tests only prove
  // the bootstrap path; this pins the PRODUCTION path: custom-034 must run after the
  // manifest to make the column STORED-generated AND (re)create the GIN index, with a
  // working end-to-end full-text-search round-trip.
  it('makes content_tsvector generated + GIN-indexed + searchable via the drizzle runMigrations (production) path', async () => {
    const client = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    const migrationResult = await runMigrations(client);
    if (!migrationResult.success) {
      throw new Error(`Migrations failed: ${migrationResult.error}`);
    }

    // 's' = STORED generated; '' = the leftover plain column the manifest creates.
    const gen = await client.query(
      `SELECT attgenerated FROM pg_attribute
        WHERE attrelid = 'file_chunks'::regclass AND attname = 'content_tsvector'`
    );
    expect((gen.rows[0] as { attgenerated: string } | undefined)?.attgenerated).toBe('s');

    // The manifest never created this GIN index; 034 restores it (the actual prod fix).
    const idx = await client.query(
      `SELECT 1 FROM pg_indexes
        WHERE tablename = 'file_chunks' AND indexname = 'idx_file_chunks_content_tsvector'`
    );
    expect(idx.rows).toHaveLength(1);

    // Insert WITHOUT setting content_tsvector, then prove FTS finds it through the
    // generated column on the production-migrated schema.
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['00000000-0000-0000-0000-0000000000aa', 'p.txt', '/tmp/p.txt', 1, now, now]
    );
    await client.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        '00000000-0000-0000-0000-0000000000bb',
        '00000000-0000-0000-0000-0000000000aa',
        0,
        'the quick brown fox jumps over the lazy dog',
        'h1',
        now,
        now,
      ]
    );
    const fts = await client.query(
      `SELECT id FROM file_chunks
        WHERE content_tsvector @@ to_tsquery('english', 'quick & fox')`
    );
    expect((fts.rows as { id: string }[]).map((r) => r.id)).toContain(
      '00000000-0000-0000-0000-0000000000bb'
    );

    await client.close();
  });
});
