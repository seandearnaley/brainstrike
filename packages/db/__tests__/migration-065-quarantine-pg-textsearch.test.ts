import { PGlite } from '@electric-sql/pglite';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations';
import { migration065QuarantinePgTextsearch } from '../src/migrations/065-quarantine-pg-textsearch';
import { wasmLoader } from '../src/wasm-loader';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 065: quarantine pg_textsearch', () => {
  let db: PGlite | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('removes the BM25 index and extension while preserving built-in lexical search', async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch } });
    await db.exec(`
      CREATE TABLE file_chunks (
        id text PRIMARY KEY,
        content text NOT NULL,
        content_tsvector tsvector GENERATED ALWAYS AS (
          to_tsvector('english'::regconfig, content)
        ) STORED
      );
      CREATE INDEX idx_file_chunks_content_tsvector
        ON file_chunks USING gin (content_tsvector);
      CREATE EXTENSION pg_textsearch;
      CREATE INDEX idx_file_chunks_content_bm25
        ON file_chunks USING bm25 (content) WITH (text_config='english');
      INSERT INTO file_chunks (id, content)
      VALUES ('chunk-1', 'database recovery indexing');
    `);

    await db.exec(migration065QuarantinePgTextsearch.up as string);

    const extensions = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_textsearch'"
    );
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname IN (
         'idx_file_chunks_content_bm25',
         'idx_file_chunks_content_tsvector'
       )
       ORDER BY indexname`
    );
    const lexicalMatches = await db.query<{ id: string }>(
      `SELECT id
       FROM file_chunks
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'recovery')`
    );

    expect(extensions.rows).toEqual([]);
    expect(indexes.rows).toEqual([{ indexname: 'idx_file_chunks_content_tsvector' }]);
    expect(lexicalMatches.rows).toEqual([{ id: 'chunk-1' }]);
  });

  it('is idempotent when the unsafe objects are already absent', async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch } });
    await db.exec('CREATE TABLE file_chunks (id text PRIMARY KEY, content text NOT NULL)');

    await expect(db.exec(migration065QuarantinePgTextsearch.up as string)).resolves.toBeDefined();
  });

  it('keeps repeated chunk updates readable after a durable close and reopen', async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-pg-textsearch-quarantine-integrity');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(`
      INSERT INTO file_records (id, name, path, size, created_at, updated_at)
      VALUES ('file-1', 'index.md', '/index.md', 16, now()::text, now()::text);
      INSERT INTO file_chunks (
        id,
        file_record_id,
        chunk_index,
        content,
        content_hash,
        created_at,
        updated_at
      )
      VALUES (
        'chunk-1',
        'file-1',
        0,
        'initial indexing content',
        'hash-0',
        now()::text,
        now()::text
      );
      DO $$
      BEGIN
        FOR revision IN 1..250 LOOP
          UPDATE file_chunks
          SET
            content = 'indexing content revision ' || revision::text,
            content_hash = 'hash-' || revision::text,
            updated_at = now()::text
          WHERE id = 'chunk-1';
        END LOOP;
      END
      $$;
      CHECKPOINT;
    `);

    await db.close();
    db = null;
    db = await wasmLoader.createPGlite(dataDir);

    const row = await db.query<{ content: string; lexical_match: boolean }>(
      `SELECT
         content,
         content_tsvector @@ websearch_to_tsquery('english', 'revision') AS lexical_match
       FROM file_chunks
       WHERE id = 'chunk-1'`
    );
    const unsafeObjects = await db.query<{ object_name: string }>(
      `SELECT extname AS object_name
       FROM pg_extension
       WHERE extname = 'pg_textsearch'
       UNION ALL
       SELECT indexname AS object_name
       FROM pg_indexes
       WHERE indexname = 'idx_file_chunks_content_bm25'`
    );

    expect(row.rows).toEqual([
      {
        content: 'indexing content revision 250',
        lexical_match: true,
      },
    ]);
    expect(unsafeObjects.rows).toEqual([]);
  });
});
