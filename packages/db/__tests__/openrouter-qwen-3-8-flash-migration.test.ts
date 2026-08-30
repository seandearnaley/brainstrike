import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CatalogRow {
  capabilities: { streaming: boolean; type: string; vision: boolean };
  id: string;
  is_enabled: boolean;
  name: string;
  sort_order: number;
}

describe('OpenRouter Qwen3.8 Flash migration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-qwen-3-8-flash'));
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds the route disabled, preserves its toggle and ordering, and rolls back', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 112));
    const migration113 = migrations.find((migration) => migration.version === 113);
    if (!migration113) {
      throw new Error('Migration 113 is missing');
    }

    const readRows = async (): Promise<CatalogRow[]> => {
      const result = await db.query<CatalogRow>(`
        SELECT id, name, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN ('qwen/qwen3.8-flash', 'z-ai/glm-5.3')
        ORDER BY sort_order
      `);
      return result.rows;
    };
    const readNonOpenRouterOrdering = async (): Promise<
      Array<{ id: string; sort_order: number }>
    > => {
      const result = await db.query<{ id: string; sort_order: number }>(`
        SELECT id, sort_order
        FROM models
        WHERE provider_id <> 'openrouter'
        ORDER BY provider_id, sort_order, id
      `);
      return result.rows;
    };
    const nonOpenRouterOrdering = await readNonOpenRouterOrdering();

    await runner.runMigration(migration113);
    const ordering = await db.query<{ row_count: number; unique_sort_order_count: number }>(`
      SELECT
        COUNT(*)::int AS row_count,
        COUNT(DISTINCT sort_order)::int AS unique_sort_order_count
      FROM models
      WHERE provider_id = 'openrouter'
    `);
    expect(ordering.rows[0]).toBeDefined();
    expect(ordering.rows[0]?.row_count).toBe(ordering.rows[0]?.unique_sort_order_count);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'qwen/qwen3.8-flash',
        is_enabled: false,
        name: 'Qwen3.8 Flash (OpenRouter)',
        sort_order: 0,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'z-ai/glm-5.3',
        is_enabled: false,
        name: 'GLM-5.3 (OpenRouter)',
        sort_order: 1,
      },
    ]);
    expect(await readNonOpenRouterOrdering()).toEqual(nonOpenRouterOrdering);

    await db.query("UPDATE models SET is_enabled = true WHERE id = 'qwen/qwen3.8-flash'");
    await runner.down(migrations, 112);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'z-ai/glm-5.3',
        is_enabled: false,
        name: 'GLM-5.3 (OpenRouter)',
        sort_order: 1,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'qwen/qwen3.8-flash',
          'openrouter',
          'stale name',
          'stale tagline',
          '["stale"]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.runMigration(migration113);
    expect((await readRows())[0]).toEqual({
      capabilities: { streaming: true, type: 'llm', vision: true },
      id: 'qwen/qwen3.8-flash',
      is_enabled: true,
      name: 'Qwen3.8 Flash (OpenRouter)',
      sort_order: 0,
    });
  });

  it('registers the route in the production custom migration ledger', {
    timeout: 60_000,
  }, async () => {
    const result = await runMigrations(db);

    expect(result.success).toBe(true);
    expect(result.appliedMigrations).toContain('openrouter_qwen_3_8_flash');
    const ledger = await db.query<{ hash: string }>(`
      SELECT hash
      FROM __drizzle_migrations
      WHERE hash = 'custom-113-openrouter-qwen-3-8-flash'
    `);
    expect(ledger.rows).toEqual([{ hash: 'custom-113-openrouter-qwen-3-8-flash' }]);
  });
});
