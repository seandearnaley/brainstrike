import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

// BST-1693. Lives outside frontier-models-migration.test.ts because that file
// is already at Biome's per-file line ceiling.
describe('migration 124 — direct Google Gemini Flash catalog rows', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-google-flash-124');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('appends the three direct Gemini Flash rows disabled, preserves toggles, and rolls back migration 124 (BST-1693)', {
    timeout: 60_000,
  }, async () => {
    await runner.initialize();
    await runner.up(migrations);

    const newIds = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

    const readNewRows = async (): Promise<
      Array<{
        best_for: string[];
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        tagline: string;
      }>
    > => {
      const result = await db.query<{
        best_for: string[];
        capabilities: { streaming: boolean; type: string; vision: boolean };
        id: string;
        is_enabled: boolean;
        name: string;
        tagline: string;
      }>(
        `
        SELECT id, name, tagline, best_for, capabilities, is_enabled
        FROM models
        WHERE provider_id = 'google'
          AND id = ANY($1)
        ORDER BY sort_order
      `,
        [newIds]
      );
      return result.rows;
    };

    expect(await readNewRows()).toEqual([
      {
        best_for: [
          'Long-horizon software engineering',
          'Autonomous agents',
          'Complex enterprise workflows',
        ],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.8-flash',
        is_enabled: false,
        name: 'Gemini 3.8 Flash',
        tagline: 'Long-horizon software engineering and autonomous agents at Flash speed',
      },
      {
        best_for: ['Code generation', 'Agentic execution', 'Spatial reasoning'],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.6-flash',
        is_enabled: false,
        name: 'Gemini 3.6 Flash',
        tagline: 'Frontier intelligence for code generation and agentic execution',
      },
      {
        best_for: [
          'High-throughput subagent tasks',
          'Document parsing',
          'Low-latency multimodal execution',
        ],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'gemini-3.5-flash-lite',
        is_enabled: false,
        name: 'Gemini 3.5 Flash-Lite',
        tagline: 'Low-latency multimodal for high-throughput subagent tasks and document parsing',
      },
    ]);

    // The append must not renumber the rows that were already there.
    const sortOrderOf = async (id: string): Promise<number | undefined> => {
      const res = await db.query<{ sort_order: number }>(
        "SELECT sort_order FROM models WHERE provider_id = 'google' AND id = $1",
        [id]
      );
      return res.rows[0]?.sort_order;
    };
    const flash35SortOrder = await sortOrderOf('gemini-3.5-flash');
    expect(await sortOrderOf('gemini-3.7-flash')).toBe(1);
    for (const id of newIds) {
      expect(await sortOrderOf(id)).toBeGreaterThan(flash35SortOrder as number);
    }

    // Roll back exactly 124, so a sibling migration landing at 125/126 cannot
    // change what this assertion means.
    const only124 = migrations.filter((migration) => migration.version === 124);
    await runner.down(only124);
    expect(await readNewRows()).toEqual([]);
    // Rolling the new rows back leaves the pre-existing google catalog intact.
    expect(await sortOrderOf('gemini-3.7-flash')).toBe(1);
    expect(await sortOrderOf('gemini-3.5-flash')).toBe(flash35SortOrder);

    // A stale row the user had enabled is refreshed on re-apply, but the
    // is_enabled toggle survives (`is_enabled = models.is_enabled`).
    await db.query(`
      INSERT INTO models
        (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
      VALUES
        (
          'gemini-3.8-flash',
          'google',
          'stale name',
          'stale tagline',
          '[]',
          '{"type":"llm","streaming":false,"vision":false}',
          99,
          true
        )
    `);
    await runner.up(only124);
    const reapplied = (await readNewRows())[0];
    expect(reapplied?.name).toBe('Gemini 3.8 Flash');
    expect(reapplied?.tagline).toBe(
      'Long-horizon software engineering and autonomous agents at Flash speed'
    );
    expect(reapplied?.capabilities).toEqual({ streaming: true, type: 'llm', vision: true });
    expect(reapplied?.is_enabled).toBe(true);
  });
});
