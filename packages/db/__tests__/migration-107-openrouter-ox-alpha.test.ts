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

function getMigration107(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 107);
  if (!migration) {
    throw new Error('Migration 107 is missing');
  }
  return migration;
}

async function readOxAlpha(db: PGlite): Promise<CatalogRow | undefined> {
  const result = await db.query<CatalogRow>(`
    SELECT id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled
    FROM models
    WHERE id = 'stealth/ox-alpha'
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

describe('migration 107 OpenRouter Ox Alpha', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-ox-alpha'));
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('is registered as numbered migration 107', () => {
    expect(getMigration107().name).toBe('openrouter_ox_alpha');
  });

  it('adds a disabled route, refreshes stale metadata without clobbering its toggle, and rolls back', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 106));

    const migration107 = getMigration107();
    const originalOrdering = await readOpenRouterOrdering(db);

    await runner.runMigration(migration107);

    expect(await readOxAlpha(db)).toEqual({
      best_for: [],
      capabilities: { streaming: true, type: 'llm', vision: true },
      id: 'stealth/ox-alpha',
      is_enabled: false,
      name: 'Ox Alpha (OpenRouter)',
      provider_id: 'openrouter',
      sort_order: 1,
      tagline: null,
    });
    expect(await readOpenRouterOrdering(db)).toEqual([
      { id: 'stealth/ox-alpha', sort_order: 1 },
      ...originalOrdering.map((model) => ({ ...model, sort_order: model.sort_order + 1 })),
    ]);

    await runner.down(migrations, 106);
    expect(await readOxAlpha(db)).toBeUndefined();
    expect(await readOpenRouterOrdering(db)).toEqual(originalOrdering);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'stealth/ox-alpha',
          'openrouter',
          'stale name',
          'stale tagline',
          '["stale"]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);

    await runner.runMigration(migration107);
    expect(await readOxAlpha(db)).toEqual({
      best_for: [],
      capabilities: { streaming: true, type: 'llm', vision: true },
      id: 'stealth/ox-alpha',
      is_enabled: true,
      name: 'Ox Alpha (OpenRouter)',
      provider_id: 'openrouter',
      sort_order: 1,
      tagline: null,
    });
    expect(await readOpenRouterOrdering(db)).toEqual([
      { id: 'stealth/ox-alpha', sort_order: 1 },
      ...originalOrdering.map((model) => ({ ...model, sort_order: model.sort_order + 1 })),
    ]);

    await runner.down(migrations, 106);
    expect(await readOxAlpha(db)).toBeUndefined();
    expect(await readOpenRouterOrdering(db)).toEqual(originalOrdering);
  });
});

describe('migration 107 in the production drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('is registered in the custom migration ledger and later retired by 121', {
    timeout: 60_000,
  }, async () => {
    const result = await runMigrations(db);

    expect(result.success).toBe(true);
    // 107 still applies and is still in the ledger — the ledger is append-only,
    // so retiring the row it added never un-applies the migration.
    expect(result.appliedMigrations).toContain('openrouter_ox_alpha');
    expect(result.appliedMigrations).toContain('retire_delisted_openrouter_models');
    // BST-1697: OpenRouter delisted stealth/ox-alpha, so migration 121 deletes
    // the row this migration added. The full production sequence must end with
    // no Ox Alpha row at all.
    expect(await readOxAlpha(db)).toBeUndefined();

    const ledger = await db.query<{ hash: string }>(`
      SELECT hash
      FROM __drizzle_migrations
      WHERE hash = 'custom-107-openrouter-ox-alpha'
    `);
    expect(ledger.rows).toEqual([{ hash: 'custom-107-openrouter-ox-alpha' }]);
  });
});
