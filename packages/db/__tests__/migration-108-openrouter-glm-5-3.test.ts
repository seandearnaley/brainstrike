import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import type { Migration } from '../src/migrations/migration-runner.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CatalogRow {
  best_for: unknown[];
  capabilities: { streaming: boolean; type: string; vision: boolean };
  id: string;
  is_enabled: boolean;
  name: string;
  provider_id: string;
  sort_order: number;
  tagline: string | null;
}

interface OrderedModel {
  id: string;
  sort_order: number;
}

function getMigration108(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 108);
  if (!migration) {
    throw new Error('Migration 108 is missing');
  }
  return migration;
}

async function readGlm53(db: PGlite): Promise<CatalogRow | undefined> {
  const result = await db.query<CatalogRow>(`
    SELECT id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled
    FROM models
    WHERE id = 'z-ai/glm-5.3'
  `);
  return result.rows[0];
}

async function readOpenRouterOrdering(db: PGlite): Promise<OrderedModel[]> {
  const result = await db.query<OrderedModel>(`
    SELECT id, sort_order
    FROM models
    WHERE provider_id = 'openrouter'
    ORDER BY sort_order, id
  `);
  return result.rows;
}

async function readNonOpenRouterOrdering(db: PGlite): Promise<OrderedModel[]> {
  const result = await db.query<OrderedModel>(`
    SELECT id, sort_order
    FROM models
    WHERE provider_id <> 'openrouter'
    ORDER BY provider_id, sort_order, id
  `);
  return result.rows;
}

const EXPECTED_GLM_53_ROW: CatalogRow = {
  best_for: [],
  capabilities: { streaming: true, type: 'llm', vision: false },
  id: 'z-ai/glm-5.3',
  is_enabled: false,
  name: 'GLM-5.3 (OpenRouter)',
  provider_id: 'openrouter',
  sort_order: 1,
  tagline: null,
};

describe('migration 108 OpenRouter GLM 5.3', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-glm-5-3'));
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('is registered as numbered migration 108', () => {
    expect(getMigration108().name).toBe('openrouter_glm_5_3');
  });

  it('inserts disabled, refreshes stale metadata, preserves the toggle and ordering, and rolls back', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 107));

    const migration108 = getMigration108();
    const originalOrdering = await readOpenRouterOrdering(db);
    const otherProviderOrdering = await readNonOpenRouterOrdering(db);

    await runner.runMigration(migration108);
    expect(await readGlm53(db)).toEqual(EXPECTED_GLM_53_ROW);
    expect(await readOpenRouterOrdering(db)).toEqual([
      { id: 'z-ai/glm-5.3', sort_order: 1 },
      ...originalOrdering.map((model) => ({ ...model, sort_order: model.sort_order + 1 })),
    ]);
    expect(await readNonOpenRouterOrdering(db)).toEqual(otherProviderOrdering);

    await runner.down(migrations, 107);
    expect(await readGlm53(db)).toBeUndefined();
    expect(await readOpenRouterOrdering(db)).toEqual(originalOrdering);
    expect(await readNonOpenRouterOrdering(db)).toEqual(otherProviderOrdering);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'z-ai/glm-5.3',
          'openrouter',
          'stale name',
          'stale tagline',
          '["stale"]',
          '{"type":"llm","streaming":false,"vision":true}',
          99,
          true
        )
    `);

    await runner.runMigration(migration108);
    expect(await readGlm53(db)).toEqual({
      ...EXPECTED_GLM_53_ROW,
      is_enabled: true,
    });
    expect(await readOpenRouterOrdering(db)).toEqual([
      { id: 'z-ai/glm-5.3', sort_order: 1 },
      ...originalOrdering.map((model) => ({ ...model, sort_order: model.sort_order + 1 })),
    ]);
    expect(await readNonOpenRouterOrdering(db)).toEqual(otherProviderOrdering);

    await runner.down(migrations, 107);
    expect(await readGlm53(db)).toBeUndefined();
    expect(await readOpenRouterOrdering(db)).toEqual(originalOrdering);
    expect(await readNonOpenRouterOrdering(db)).toEqual(otherProviderOrdering);
  });
});

describe('migration 108 in the production drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('is registered in the custom migration ledger', {
    timeout: 60_000,
  }, async () => {
    const result = await runMigrations(db);

    expect(result.success).toBe(true);
    expect(result.appliedMigrations).toContain('openrouter_glm_5_3');
    // GLM 5.3 still leads the OpenRouter block, but at 2 rather than 1:
    // migration 113 seeded qwen/qwen3.8-flash at sort_order 0, and BST-1697's
    // migration 121 renumbers the whole block to the 1..N convention every
    // other catalog migration follows. Relative order is unchanged.
    expect(await readGlm53(db)).toEqual({ ...EXPECTED_GLM_53_ROW, sort_order: 2 });

    const ledger = await db.query<{ hash: string }>(`
      SELECT hash
      FROM __drizzle_migrations
      WHERE hash = 'custom-108-openrouter-glm-5-3'
    `);
    expect(ledger.rows).toEqual([{ hash: 'custom-108-openrouter-glm-5-3' }]);
  });
});
