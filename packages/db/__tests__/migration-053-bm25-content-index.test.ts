import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface IndexRow {
  indexname: string;
}

interface ExtensionRow {
  extname: string;
}

interface RankedRow {
  id: string;
}

const INDEX_NAME = 'idx_file_chunks_content_bm25';

describe('migration 053: pg_textsearch extension + bm25 content index', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-bm25-content-index');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 53));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration053() {
    const migration = migrations.find((candidate) => candidate.version === 53);
    if (!migration) {
      throw new Error('Migration 053 is missing');
    }
    return migration;
  }

  async function listBm25Index(): Promise<IndexRow[]> {
    const result = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE indexname = '${INDEX_NAME}'`
    );
    return result.rows;
  }

  async function listExtension(): Promise<ExtensionRow[]> {
    const result = await db.query<ExtensionRow>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_textsearch'"
    );
    return result.rows;
  }

  it('up creates the extension and the bm25 index', async () => {
    await runner.up([getMigration053()]);

    expect(await listExtension()).toHaveLength(1);
    expect(await listBm25Index()).toHaveLength(1);
  });

  it('up is idempotent (IF NOT EXISTS on both statements)', async () => {
    await runner.up([getMigration053()]);
    await db.exec(getMigration053().up as string);

    expect(await listExtension()).toHaveLength(1);
    expect(await listBm25Index()).toHaveLength(1);
  });

  it('down drops the index then the extension', async () => {
    await runner.up([getMigration053()]);
    await runner.down([getMigration053()]);

    expect(await listBm25Index()).toHaveLength(0);
    expect(await listExtension()).toHaveLength(0);
  });

  it('the index serves BM25-ordered queries and scores rows inserted after the build', async () => {
    await runner.up([getMigration053()]);

    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ('f1', 'a.md', '/a.md', 1, now()::text, now()::text)`
    );
    const insertChunk = async (id: string, index: number, content: string): Promise<void> => {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
         VALUES ($1, 'f1', $2, $3, $4, now()::text, now()::text)`,
        [id, index, content, `hash-${id}`]
      );
    };
    await insertChunk('c1', 0, 'the pipeline retries the queue');
    await insertChunk('c2', 1, 'the pipeline converts a quaternion rotation');

    const result = await db.query<RankedRow>(
      `SELECT id FROM file_chunks
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'pipeline OR quaternion')
       ORDER BY -(content <@> to_bm25query('pipeline quaternion', '${INDEX_NAME}')) DESC, id
       LIMIT 5`
    );

    expect(result.rows.map((row) => row.id)).toEqual(['c2', 'c1']);
  });
});
