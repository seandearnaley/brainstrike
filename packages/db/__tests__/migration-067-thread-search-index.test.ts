import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CountRow {
  count: number | string;
}

describe('migration 067: thread search index tables', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-thread-search-index');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 67));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration067() {
    const migration = migrations.find((candidate) => candidate.version === 67);
    if (!migration) {
      throw new Error('Migration 067 is missing');
    }
    return migration;
  }

  it('creates the index, profile, and state tables', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration067());

    const tables = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name IN (
         'brainstrike_thread_message_index',
         'brainstrike_thread_search_profiles',
         'brainstrike_thread_search_state'
       )`
    );
    expect(Number(tables.rows[0]?.count ?? 0)).toBe(3);
  });

  it('seeds the singleton embedding profile and rejects a second row', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration067());

    const profile = await db.query<{
      dimensions: number;
      distance: string;
      id: string;
      model_key: string;
    }>('SELECT id, model_key, dimensions, distance FROM brainstrike_thread_search_profiles');
    expect(profile.rows).toHaveLength(1);
    expect(profile.rows[0]?.id).toBe('default');
    expect(profile.rows[0]?.distance).toBe('cosine');
    expect(profile.rows[0]?.dimensions).toBeGreaterThan(0);
    expect(profile.rows[0]?.model_key).toContain('local:');

    await expect(
      db.query(
        `INSERT INTO brainstrike_thread_search_profiles (id, model_id, model_key, dimensions)
         VALUES ('second', 'model', 'local::model', 384)`
      )
    ).rejects.toThrow();
  });

  it('populates the generated tsvector column from content_text', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration067());

    await db.query(
      `INSERT INTO brainstrike_thread_message_index (
         message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
       ) VALUES (
         'msg-1', 'thread-1', 'workspace', 'user',
         'tuning hnsw ef_search for pglite vectors', 'hash-1', NOW()
       )`
    );

    const matches = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM brainstrike_thread_message_index
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'hnsw tuning')`
    );
    expect(Number(matches.rows[0]?.count ?? 0)).toBe(1);

    const misses = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM brainstrike_thread_message_index
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'unrelated topic')`
    );
    expect(Number(misses.rows[0]?.count ?? 0)).toBe(0);
  });

  it('has a GIN index over the generated tsvector column', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration067());

    const indexes = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'brainstrike_thread_message_index'
         AND indexdef ILIKE '%USING gin%content_tsvector%'`
    );
    expect(indexes.rows).toHaveLength(1);
  });

  it('supports the content-hash CAS upsert that resets a stale embedding', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration067());

    await db.query(
      `INSERT INTO brainstrike_thread_message_index (
         message_id, thread_id, resource_id, role, content_text, content_hash,
         message_created_at, embedding, embedding_profile_id, embedding_updated_at
       ) VALUES (
         'msg-1', 'thread-1', 'workspace', 'assistant',
         'original words', 'hash-old', NOW(), '[1,2,3]'::vector, 'default', NOW()
       )`
    );

    // Same hash: the embedding survives (WHERE clause blocks the update).
    await db.query(
      `INSERT INTO brainstrike_thread_message_index (
         message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
       ) VALUES ('msg-1', 'thread-1', 'workspace', 'assistant', 'original words', 'hash-old', NOW())
       ON CONFLICT (message_id) DO UPDATE SET
         content_text = EXCLUDED.content_text,
         content_hash = EXCLUDED.content_hash,
         embedding = NULL,
         embedding_profile_id = NULL,
         embedding_error = NULL,
         embedding_updated_at = NULL,
         updated_at = NOW()
       WHERE brainstrike_thread_message_index.content_hash IS DISTINCT FROM EXCLUDED.content_hash`
    );
    const unchanged = await db.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding
       FROM brainstrike_thread_message_index WHERE message_id = 'msg-1'`
    );
    expect(unchanged.rows[0]?.has_embedding).toBe(true);

    // Changed hash: content refreshes and the embedding resets to pending.
    await db.query(
      `INSERT INTO brainstrike_thread_message_index (
         message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
       ) VALUES ('msg-1', 'thread-1', 'workspace', 'assistant', 'rewritten words', 'hash-new', NOW())
       ON CONFLICT (message_id) DO UPDATE SET
         content_text = EXCLUDED.content_text,
         content_hash = EXCLUDED.content_hash,
         embedding = NULL,
         embedding_profile_id = NULL,
         embedding_error = NULL,
         embedding_updated_at = NULL,
         updated_at = NOW()
       WHERE brainstrike_thread_message_index.content_hash IS DISTINCT FROM EXCLUDED.content_hash`
    );
    const refreshed = await db.query<{ content_text: string; has_embedding: boolean }>(
      `SELECT content_text, embedding IS NOT NULL AS has_embedding
       FROM brainstrike_thread_message_index WHERE message_id = 'msg-1'`
    );
    expect(refreshed.rows[0]?.content_text).toBe('rewritten words');
    expect(refreshed.rows[0]?.has_embedding).toBe(false);
  });

  it('rollback drops all three tables', { timeout: 60_000 }, async () => {
    const migration = getMigration067();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const tables = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name IN (
         'brainstrike_thread_message_index',
         'brainstrike_thread_search_profiles',
         'brainstrike_thread_search_state'
       )`
    );
    expect(Number(tables.rows[0]?.count ?? -1)).toBe(0);
  });
});
