import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const MIGRATION_RUN_TIMEOUT_MS = 60_000;

/**
 * Every name the four audited redundant indexes go by on EITHER migration
 * path (docs/pg18-skip-scan-audit.md). After a full run of either runner,
 * none of these may exist.
 */
const DROPPED_INDEX_NAMES = [
  'idx_embedding_cache_content_hash',
  'idx_file_token_cache_lookup',
  'idx_token_cache_lookup',
  'idx_file_token_cache_folder',
  'idx_token_cache_folder',
  'idx_prompt_item_revisions_item_revision',
] as const;

async function queryIndexNames(db: PGlite, names: readonly string[]): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ANY($1::text[])
     ORDER BY indexname`,
    [[...names]]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 063: index consolidation (numbered runner)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-index-consolidation'));
    runner = new MigrationRunner(db);
    await runner.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration063() {
    const migration = migrations.find((candidate) => candidate.version === 63);
    if (!migration) {
      throw new Error('Migration 063 is missing');
    }
    return migration;
  }

  it(
    'drops the four redundant indexes and keeps the unique survivors',
    async () => {
      await runner.up(migrations);

      expect(await queryIndexNames(db, DROPPED_INDEX_NAMES)).toEqual([]);

      // Correctness-bearing survivors on the numbered path: the folder+path
      // UNIQUE constraint index (migration 016) and the (prompt_item_id,
      // revision) UNIQUE constraint index (migration 051).
      const survivors = await queryIndexNames(db, [
        'file_token_cache_folder_id_file_path_key',
        'prompt_item_revisions_unique',
        'idx_token_cache_mode',
      ]);
      expect(survivors).toEqual([
        'file_token_cache_folder_id_file_path_key',
        'idx_token_cache_mode',
        'prompt_item_revisions_unique',
      ]);
    },
    MIGRATION_RUN_TIMEOUT_MS
  );

  it(
    'rollback restores the dropped indexes on tables that exist on this path',
    async () => {
      await runner.up(migrations);
      await runner.rollback(getMigration063());

      // embedding_cache does not exist on the numbered path; its guarded
      // recreate must no-op instead of failing the whole rollback.
      const restored = await queryIndexNames(db, DROPPED_INDEX_NAMES);
      expect(restored).toEqual([
        'idx_file_token_cache_folder',
        'idx_file_token_cache_lookup',
        'idx_prompt_item_revisions_item_revision',
      ]);
    },
    MIGRATION_RUN_TIMEOUT_MS
  );
});

describe('migration 063: index consolidation (drizzle runner)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it(
    'drops the four redundant indexes and keeps the unique survivors',
    async () => {
      const result = await runMigrations(db, { enableVector: true });
      expect(result.success).toBe(true);
      expect(result.appliedMigrations).toContain('index_consolidation');

      expect(await queryIndexNames(db, DROPPED_INDEX_NAMES)).toEqual([]);

      // Correctness-bearing survivors on the drizzle (real-app) path.
      const survivors = await queryIndexNames(db, [
        'idx_embedding_cache_content_model',
        'idx_file_token_cache_folder_path_unique',
        'idx_file_token_cache_mode',
        'prompt_item_revisions_unique',
      ]);
      expect(survivors).toEqual([
        'idx_embedding_cache_content_model',
        'idx_file_token_cache_folder_path_unique',
        'idx_file_token_cache_mode',
        'prompt_item_revisions_unique',
      ]);
    },
    MIGRATION_RUN_TIMEOUT_MS
  );
});
