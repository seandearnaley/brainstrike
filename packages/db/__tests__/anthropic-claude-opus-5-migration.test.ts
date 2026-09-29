import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration116AnthropicClaudeOpus5 as migration } from '../src/migrations/116-anthropic-claude-opus-5.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

// Migrations 122 (BST-1691) and 142 (BST-1804) append Claude Fable 5.1 and
// Claude Opus 5.5 after the existing rows, so the post-migration order below
// is two longer than it was when migration 116 shipped. Opus 5 keeps slot 2.
const expectedOrder = [
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5-1',
  'claude-opus-5-5',
].map((id, index) => ({ id, sort_order: index + 1 }));

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

    const ordered = await db.query<{
      id: string;
      is_enabled: boolean;
      sort_order: number;
      streaming: string | null;
      tagline: string | null;
      type: string | null;
      vision: string | null;
    }>(
      `SELECT id, is_enabled, tagline, sort_order,
              capabilities->>'type' AS type,
              capabilities->>'streaming' AS streaming,
              capabilities->>'vision' AS vision
         FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order`
    );
    const rows = ordered.rows;

    expect(rows.map((row) => row.id)).toEqual(expectedOrder.map((entry) => entry.id));

    const opus = rows.find((row) => row.id === 'claude-opus-5');
    expect(opus).toBeDefined();
    expect(opus?.is_enabled).toBe(false);
    expect(opus?.tagline).toBe('For complex agentic coding and enterprise work');
    expect(opus?.sort_order).toBe(2);
    expect(opus?.type).toBe('llm');
    expect(opus?.streaming).toBe('true');
    expect(opus?.vision).toBe('true');
  });

  it.each([true, false])(
    'preserves an existing is_enabled choice for Claude Opus 5 (ON CONFLICT: %s)',
    {
      timeout: 60_000,
    },
    async (enabled) => {
      await runner.initialize();
      // Catalog state before migration 116 ships: a pre-existing row (e.g. a
      // build that already knew the model) with an explicit user toggle.
      await runner.up(migrations.filter((entry) => entry.version < migration.version));
      await db.query(
        `INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
       VALUES ('claude-opus-5', 'anthropic', 'Claude Opus 5', NULL, '[]', '{"type":"llm","streaming":true}', 2, $1)`,
        [enabled]
      );

      await runner.up(migrations);

      const res = await db.query("SELECT is_enabled FROM models WHERE id = 'claude-opus-5'");
      expect(res.rows[0]).toEqual({ is_enabled: enabled });
      const ordered = await db.query(
        "SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order"
      );
      expect(ordered.rows).toEqual(expectedOrder);
      if (typeof migration.up !== 'string') {
        throw new Error('Expected SQL migration');
      }
      await db.exec(migration.up);
      expect(
        (
          await db.query(
            "SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order"
          )
        ).rows
      ).toEqual(expectedOrder);
    }
  );

  it('rolls back cleanly: removes Claude Opus 5 and restores Anthropic ordering', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);
    await runner.down(migrations, migration.version - 1);

    const res = await db.query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order`
    );
    const rows = res.rows;

    if (typeof migration.down !== 'string') {
      throw new Error('Expected SQL rollback');
    }
    await db.exec(migration.down);
    expect(
      (
        await db.query(
          "SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order"
        )
      ).rows
    ).toEqual(rows);
    expect(rows.map((row) => row.id)).not.toContain('claude-opus-5');
    expect(rows).toEqual([
      { id: 'claude-fable-5', sort_order: 1 },
      { id: 'claude-opus-4-8', sort_order: 2 },
      { id: 'claude-sonnet-5', sort_order: 3 },
      { id: 'claude-sonnet-4-6', sort_order: 4 },
      { id: 'claude-haiku-4-5', sort_order: 5 },
    ]);
    // A later catalog insertion moves Opus 5's slot. Rollback must use that
    // actual slot, preserving the newer row and its composed sibling order.
    if (typeof migration.up !== 'string') {
      throw new Error('Expected SQL migration');
    }
    await db.exec(migration.up);
    await db.exec(`
      UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'anthropic';
      INSERT INTO models (id, provider_id, name, sort_order, is_enabled)
      VALUES ('future-anthropic', 'anthropic', 'Future model fixture', 1, false);
    `);
    await db.exec(migration.down);
    expect(
      (
        await db.query(
          "SELECT id, sort_order FROM models WHERE provider_id = 'anthropic' ORDER BY sort_order"
        )
      ).rows
    ).toEqual([
      { id: 'future-anthropic', sort_order: 1 },
      ...rows.map((row) => ({ ...row, sort_order: row.sort_order + 1 })),
    ]);
  });
});
