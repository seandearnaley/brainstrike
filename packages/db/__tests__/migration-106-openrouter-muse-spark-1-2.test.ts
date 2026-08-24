import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration106OpenRouterMuseSpark12 } from '../src/migrations/106-openrouter-muse-spark-1-2.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 106 OpenRouter Muse Spark 1.2', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-muse-spark-1-2');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('remains registered as numbered migration 106', () => {
    expect(migrations.find((migration) => migration.version === 106)).toBe(
      migration106OpenRouterMuseSpark12
    );
  });

  it('adds the model disabled, preserves its toggle, and rolls back faithfully', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version <= 105));

    const migration106 = migrations.find((migration) => migration.version === 106);
    if (!migration106) {
      throw new Error('Migration 106 is missing');
    }

    const readRows = async (): Promise<
      Array<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        sort_order: number;
      }>
    > => {
      const result = await db.query<{
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        sort_order: number;
      }>(`
        SELECT id, name, capabilities, is_enabled, sort_order
        FROM models
        WHERE provider_id = 'openrouter'
          AND id IN ('meta/muse-spark-1.2', 'x-ai/grok-4.6')
        ORDER BY sort_order
      `);
      return result.rows;
    };

    await runner.runMigration(migration106);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'meta/muse-spark-1.2',
        is_enabled: false,
        name: 'Muse Spark 1.2 (OpenRouter)',
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: false,
        name: 'Grok 4.6 (OpenRouter)',
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 105);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: false,
        name: 'Grok 4.6 (OpenRouter)',
        sort_order: 1,
      },
    ]);

    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'meta/muse-spark-1.2',
          'openrouter',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(migrations.filter((migration) => migration.version <= 106));

    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'meta/muse-spark-1.2',
        is_enabled: true,
        name: 'Muse Spark 1.2 (OpenRouter)',
        sort_order: 1,
      },
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: false,
        name: 'Grok 4.6 (OpenRouter)',
        sort_order: 2,
      },
    ]);

    await runner.down(migrations, 105);
    expect(await readRows()).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'x-ai/grok-4.6',
        is_enabled: false,
        name: 'Grok 4.6 (OpenRouter)',
        sort_order: 1,
      },
    ]);
  });
});
