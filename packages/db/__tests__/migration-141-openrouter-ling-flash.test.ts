import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 141: inclusionai/ling-3.0-flash on OpenRouter', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-migration-141');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds the paid Ling flash route disabled, appended, with authored copy', {
    timeout: 60_000,
  }, async () => {
    // BST-1702. `tagline` and `best_for` are hand-authored in migration 141 —
    // the generator leaves them NULL and
    // `model-catalog-migration-contract.mjs` never reads those columns, so a
    // typo in that copy fails HERE or nowhere. The sort_order assertions are
    // relative, not absolute, because the migration appends with a live
    // `MAX(sort_order)` subquery: pinning literals would break the moment
    // another OpenRouter migration lands ahead of this one.
    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 140));

    const before = await db.query<{ max_sort_order: number | null }>(
      "SELECT MAX(sort_order) AS max_sort_order FROM models WHERE provider_id = 'openrouter'"
    );
    const maxBefore = before.rows[0]?.max_sort_order ?? 0;

    // Stop AT 141 rather than running the whole manifest: a later migration
    // is free to renumber or retire OpenRouter rows (121 already does exactly
    // that with a `row_number()` sweep), and the `appended` guarantee under
    // test belongs to 141.
    await runner.up(migrations.filter(({ version }) => version <= 141));

    const rows = await db.query<{
      best_for: readonly string[] | null;
      capabilities: { streaming?: boolean; type?: string; vision?: boolean };
      id: string;
      is_enabled: boolean;
      name: string;
      provider_id: string;
      sort_order: number;
      tagline: string | null;
    }>(`
        SELECT id, provider_id, name, tagline, best_for, capabilities, is_enabled, sort_order
        FROM models
        WHERE id = 'inclusionai/ling-3.0-flash'
      `);

    expect(rows.rows).toEqual([
      {
        best_for: [],
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'inclusionai/ling-3.0-flash',
        is_enabled: false,
        name: 'Ling 3.0 Flash (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 1,
        tagline:
          'Token-efficient 124B-parameter MoE flash route for production-scale agentic inference',
      },
    ]);

    // The Nemotron stopgap BST-1697 remapped the retired `:free` route to is
    // a DIFFERENT price point and must survive untouched: 141 only ADDS the
    // cheaper like-for-like paid route, it does not retire Nemotron.
    const sibling = await db.query<{
      id: string;
      provider_id: string;
    }>("SELECT id, provider_id FROM models WHERE id = 'nvidia/nemotron-3.5-lightning'");
    expect(sibling.rows).toEqual([
      {
        id: 'nvidia/nemotron-3.5-lightning',
        provider_id: 'openrouter',
      },
    ]);

    // Re-applying the SAME up SQL over a row the user has since enabled and a
    // stale name must refresh the catalog columns and LEAVE THE TOGGLE ALONE
    // (database.md rule 3: never `is_enabled = EXCLUDED.is_enabled`).
    const up = migrations.find(({ version }) => version === 141)?.up;
    if (typeof up !== 'string') {
      throw new Error('migration 141 must be registered with SQL-string up');
    }
    await db.query(
      "UPDATE models SET is_enabled = true, name = 'stale name', tagline = 'stale tagline', best_for = '[\"stale\"]' WHERE id = 'inclusionai/ling-3.0-flash'"
    );
    await db.exec(up);
    const reapplied = await db.query<{
      best_for: readonly string[] | null;
      is_enabled: boolean;
      name: string;
      sort_order: number;
      tagline: string | null;
    }>(
      "SELECT is_enabled, name, tagline, best_for, sort_order FROM models WHERE id = 'inclusionai/ling-3.0-flash'"
    );
    expect(reapplied.rows[0]).toEqual({
      best_for: [],
      is_enabled: true,
      name: 'Ling 3.0 Flash (OpenRouter)',
      // Unlike migration 130 (which predates the fix and drifts +1 here),
      // 141 is generated with BST-1704's per-provider exclusion, so the
      // re-applied offsets are IDENTICAL — no drift to pin.
      sort_order: maxBefore + 1,
      tagline:
        'Token-efficient 124B-parameter MoE flash route for production-scale agentic inference',
    });

    await runner.down(migrations, 140);
    const afterRollback = await db.query<{ id: string }>(
      "SELECT id FROM models WHERE id = 'inclusionai/ling-3.0-flash'"
    );
    expect(afterRollback.rows).toEqual([]);
  });
});
