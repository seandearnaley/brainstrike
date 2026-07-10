import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface PromptLibraryEmbeddingProfileRow {
  dimensions: number;
  id: string;
  model_key: string;
}

interface CountRow {
  count: number | string;
}

describe('migration 051: prompt library', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-prompt-library'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 51));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration051() {
    const migration = migrations.find((candidate) => candidate.version === 51);
    if (!migration) {
      throw new Error('Migration 051 is missing');
    }
    return migration;
  }

  it('creates durable prompt items, revision history, and a dedicated embedding space', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration051());

    const embeddingProfile = await db.query<PromptLibraryEmbeddingProfileRow>(
      `SELECT id, model_key, dimensions
       FROM prompt_embedding_profiles`
    );
    expect(embeddingProfile.rows).toEqual([
      {
        dimensions: 384,
        id: 'default',
        model_key: 'local::Xenova/all-MiniLM-L6-v2',
      },
    ]);
    const leakedCollection = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count
       FROM embedding_sets
       WHERE id = 'system:prompt-library' OR system_role = 'prompt-library'`
    );
    expect(Number(leakedCollection.rows[0]?.count ?? -1)).toBe(0);

    await db.query(
      `INSERT INTO prompt_items (
         id, kind, title, content, description, tags, model_key, revision
       ) VALUES ($1, 'snippet', $2, $3, $4, $5::jsonb, $6, 1)`,
      [
        'snippet-1',
        'Evidence block',
        'Cite the exact file and line.',
        'Reusable evidence instruction',
        JSON.stringify(['research', 'evidence']),
        null,
      ]
    );
    await db.query(
      `INSERT INTO prompt_item_revisions (
         id, prompt_item_id, revision, title, content, description, tags, note
       ) VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb, $7)`,
      [
        'revision-1',
        'snippet-1',
        'Evidence block',
        'Cite the exact file and line.',
        'Reusable evidence instruction',
        JSON.stringify(['research', 'evidence']),
        'Initial capture',
      ]
    );

    const item = await db.query<{
      content: string;
      is_favorite: boolean;
      kind: string;
      revision: number;
      tags: string[];
      use_count: number;
    }>(
      `SELECT kind, content, tags, is_favorite, revision, use_count
       FROM prompt_items
       WHERE id = 'snippet-1'`
    );
    expect(item.rows).toEqual([
      {
        content: 'Cite the exact file and line.',
        is_favorite: false,
        kind: 'snippet',
        revision: 1,
        tags: ['research', 'evidence'],
        use_count: 0,
      },
    ]);

    await expect(
      db.query(
        `INSERT INTO prompt_items (id, kind, title, content)
         VALUES ('invalid-kind', 'note', 'Invalid', 'Invalid')`
      )
    ).rejects.toThrow(/prompt_items_kind_check|check constraint/i);

    await db.query(`DELETE FROM prompt_items WHERE id = 'snippet-1'`);
    const revisions = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count
       FROM prompt_item_revisions
       WHERE prompt_item_id = 'snippet-1'`
    );
    expect(Number(revisions.rows[0]?.count ?? -1)).toBe(0);
  });

  it('rolls back every prompt-library artifact', { timeout: 60_000 }, async () => {
    const migration = getMigration051();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_name IN (
         'prompt_items',
         'prompt_item_revisions',
         'prompt_embedding_profiles'
       )
       ORDER BY table_name`
    );
    expect(tables.rows).toEqual([]);
  });
});
