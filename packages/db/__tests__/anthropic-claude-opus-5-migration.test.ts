import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

// BST-957: additive direct Anthropic Claude Opus 5 catalog route.
describe('anthropic claude opus 5 migration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-claude-opus-5');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('seeds Claude Opus 5 second among the direct Anthropic models', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);

    const ordered = await db.query(
      `SELECT id, is_enabled, tagline, sort_order,
              capabilities->>'type' AS type,
              capabilities->>'streaming' AS streaming,
              capabilities->>'vision' AS vision
         FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order`
    );
    const rows = ordered.rows.map(
      (raw) =>
        raw as {
          id: string;
          is_enabled: boolean;
          sort_order: number;
          streaming: string | null;
          tagline: string | null;
          type: string | null;
          vision: string | null;
        }
    );

    expect(rows.map((row) => row.id)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);

    const opus = rows.find((row) => row.id === 'claude-opus-5');
    expect(opus).toBeDefined();
    expect(opus?.is_enabled).toBe(true);
    expect(opus?.tagline).toBe('For complex agentic coding and enterprise work');
    expect(opus?.sort_order).toBe(2);
    expect(opus?.type).toBe('llm');
    expect(opus?.streaming).toBe('true');
    expect(opus?.vision).toBe('true');
  });

  it('preserves an existing is_enabled choice for Claude Opus 5 (ON CONFLICT)', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    // Catalog state before migration 116 ships: a pre-existing row (e.g. a
    // build that already knew the model) that the user explicitly disabled.
    await runner.up(migrations.filter((migration) => migration.version <= 115));
    await db.query(
      `INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
       VALUES ('claude-opus-5', 'anthropic', 'Claude Opus 5', NULL, '[]', '{"type":"llm","streaming":true}', 2, false)`
    );

    await runner.up(migrations);

    const res = await db.query("SELECT is_enabled FROM models WHERE id = 'claude-opus-5'");
    expect((res.rows[0] as { is_enabled: boolean } | undefined)?.is_enabled).toBe(false);
  });

  it('rolls back cleanly: removes Claude Opus 5 and restores Anthropic ordering', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);
    await runner.down(migrations, 115);

    const res = await db.query(
      `SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order`
    );
    const rows = res.rows.map((raw) => raw as { id: string; sort_order: number });

    expect(rows.map((row) => row.id)).not.toContain('claude-opus-5');
    expect(rows).toEqual([
      { id: 'claude-fable-5', sort_order: 1 },
      { id: 'claude-opus-4-8', sort_order: 2 },
      { id: 'claude-sonnet-5', sort_order: 3 },
      { id: 'claude-sonnet-4-6', sort_order: 4 },
      { id: 'claude-haiku-4-5', sort_order: 5 },
    ]);
  });
});
