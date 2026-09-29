import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 130: deepseek/deepseek-v4.1-flash on OpenRouter', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-migration-130');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('adds the vision-capable DeepSeek flash route disabled, appended, with authored copy', {
    timeout: 60_000,
  }, async () => {
    // BST-1736. `tagline` and `best_for` are hand-authored in migration 130 —
    // the generator leaves them NULL and
    // `model-catalog-migration-contract.mjs` never reads those columns, so a
    // typo in that copy fails HERE or nowhere. The sort_order assertions are
    // relative, not absolute, because the migration appends with a live
    // `MAX(sort_order)` subquery: pinning literals would break the moment
    // another OpenRouter migration lands ahead of this one.
    await runner.initialize();
    await runner.up(migrations.filter(({ version }) => version <= 129));

    const before = await db.query<{ max_sort_order: number | null }>(
      "SELECT MAX(sort_order) AS max_sort_order FROM models WHERE provider_id = 'openrouter'"
    );
    const maxBefore = before.rows[0]?.max_sort_order ?? 0;

    // Stop AT 130 rather than running the whole manifest: a later migration
    // is free to renumber or retire OpenRouter rows (121 already does exactly
    // that with a `row_number()` sweep), and the `appended` guarantee under
    // test belongs to 130.
    await runner.up(migrations.filter(({ version }) => version <= 130));

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
        WHERE id = 'deepseek/deepseek-v4.1-flash'
      `);

    expect(rows.rows).toEqual([
      {
        best_for: [],
        capabilities: { streaming: true, type: 'llm', vision: true },
        id: 'deepseek/deepseek-v4.1-flash',
        is_enabled: false,
        name: 'DeepSeek V4.1 Flash (OpenRouter)',
        provider_id: 'openrouter',
        sort_order: maxBefore + 1,
        tagline:
          "Sparse mixture-of-experts flash model on DeepSeek's Causal Encoder-Decoder architecture",
      },
    ]);

    // The cheaper text-only sibling BST-1696 added is a DIFFERENT
    // price/capability point and must survive untouched (BST-1736 ruling: do
    // not retire 0731).
    const sibling = await db.query<{
      capabilities: { vision?: boolean };
      id: string;
    }>("SELECT id, capabilities FROM models WHERE id = 'deepseek/deepseek-v4-flash-0731'");
    expect(sibling.rows).toEqual([
      {
        capabilities: { streaming: true, type: 'llm', vision: false },
        id: 'deepseek/deepseek-v4-flash-0731',
      },
    ]);

    // Re-applying the SAME up SQL over a row the user has since enabled and a
    // stale name must refresh the catalog columns and LEAVE THE TOGGLE ALONE
    // (database.md rule 3: never `is_enabled = EXCLUDED.is_enabled`).
    const up = migrations.find(({ version }) => version === 130)?.up;
    if (typeof up !== 'string') {
      throw new Error('migration 130 must be registered with SQL-string up');
    }
    await db.query(
      "UPDATE models SET is_enabled = true, name = 'stale name', tagline = 'stale tagline', best_for = '[\"stale\"]' WHERE id = 'deepseek/deepseek-v4.1-flash'"
    );
    await db.exec(up);
    const reapplied = await db.query<{
      best_for: readonly string[] | null;
      is_enabled: boolean;
      name: string;
      sort_order: number;
      tagline: string | null;
    }>(
      "SELECT is_enabled, name, tagline, best_for, sort_order FROM models WHERE id = 'deepseek/deepseek-v4.1-flash'"
    );
    expect(reapplied.rows[0]).toEqual({
      best_for: [],
      is_enabled: true,
      name: 'DeepSeek V4.1 Flash (OpenRouter)',
      // sort_order DRIFTS by +1 on re-application because the generator emits
      // `MAX(sort_order) + 1` over the whole provider and the second run's
      // MAX already includes the row the first run inserted. Harmless in
      // production (the ledger applies a migration once) and pinned here
      // rather than hidden; BST-1704 owns the generator-side fix.
      sort_order: maxBefore + 1 + 1,
      tagline:
        "Sparse mixture-of-experts flash model on DeepSeek's Causal Encoder-Decoder architecture",
    });

    await runner.down(migrations, 129);
    const afterRollback = await db.query<{ id: string }>(
      "SELECT id FROM models WHERE id = 'deepseek/deepseek-v4.1-flash'"
    );
    expect(afterRollback.rows).toEqual([]);
  });
});
