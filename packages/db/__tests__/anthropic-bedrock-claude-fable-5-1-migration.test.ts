import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration122AnthropicBedrockCatalogModels as migration } from '../src/migrations/122-anthropic-bedrock-catalog-models.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

interface OrderRow {
  id: string;
  sort_order: number;
}

const ADDED_IDS = {
  anthropic: 'claude-fable-5-1',
  bedrock: 'anthropic.claude-fable-5-1',
} as const;

const earlierMigrations = migrations.filter((entry) => entry.version < migration.version);

// BST-1691: additive Claude Fable 5.1 rows on the direct Anthropic and Bedrock
// catalogs. The expectations are DERIVED from the pre-122 catalog rather than
// hardcoded, so this file pins what migration 122 does and never re-pins the
// unrelated sibling ordering that earlier migrations own.
describe('anthropic + bedrock claude fable 5.1 migration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-claude-fable-5-1');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function order(providerId: string): Promise<{ rows: OrderRow[] }> {
    return db.query<OrderRow>(
      'SELECT id, sort_order FROM models WHERE provider_id = $1 ORDER BY sort_order',
      [providerId]
    );
  }

  async function baselineOrders(): Promise<Record<'anthropic' | 'bedrock', OrderRow[]>> {
    await runner.initialize();
    await runner.up(earlierMigrations);
    const anthropic = (await order('anthropic')).rows;
    const bedrock = (await order('bedrock')).rows;
    expect(anthropic.map((row) => row.id)).not.toContain(ADDED_IDS.anthropic);
    expect(bedrock.map((row) => row.id)).not.toContain(ADDED_IDS.bedrock);
    return { anthropic, bedrock };
  }

  function appended(baseline: OrderRow[], id: string): OrderRow[] {
    const maxSortOrder = baseline.reduce((max, row) => Math.max(max, row.sort_order), 0);
    return [...baseline, { id, sort_order: maxSortOrder + 1 }];
  }

  it('appends both rows after their provider siblings, disabled, with the authored copy', {
    timeout: 60_000,
  }, async () => {
    const baseline = await baselineOrders();
    // Stop AT 122. `appended()` asserts a provider's row list is EXACTLY the
    // baseline plus this migration's single row, so running the whole manifest
    // makes any later migration touching `anthropic` or `bedrock` read as a
    // failure here. Migration 125 (BST-1694, Claude Opus 5 on Bedrock) is the
    // first to do that. The append guarantee under test belongs to 122, so the
    // measurement stops at 122; later migrations are free to add siblings.
    await runner.up(migrations.filter(({ version }) => version <= 122));

    expect((await order('anthropic')).rows).toEqual(
      appended(baseline.anthropic, ADDED_IDS.anthropic)
    );
    expect((await order('bedrock')).rows).toEqual(appended(baseline.bedrock, ADDED_IDS.bedrock));

    const seeded = await db.query<{
      best_for: string;
      id: string;
      is_enabled: boolean;
      name: string;
      streaming: string | null;
      tagline: string | null;
      type: string | null;
      vision: string | null;
    }>(
      `SELECT id, name, tagline, best_for::text AS best_for, is_enabled,
                capabilities->>'type' AS type,
                capabilities->>'streaming' AS streaming,
                capabilities->>'vision' AS vision
           FROM models
          WHERE id IN ($1, $2)
          ORDER BY id`,
      [ADDED_IDS.bedrock, ADDED_IDS.anthropic]
    );

    expect(seeded.rows.map((row) => row.id)).toEqual([ADDED_IDS.bedrock, ADDED_IDS.anthropic]);
    expect(seeded.rows.map((row) => row.name)).toEqual([
      'Claude Fable 5.1 (Bedrock)',
      'Claude Fable 5.1',
    ]);
    for (const row of seeded.rows) {
      // New catalog rows always ship off; the user opts in.
      expect(row.is_enabled, row.id).toBe(false);
      expect(row.tagline, row.id).toBe('For demanding reasoning and long-horizon agentic work');
      expect(JSON.parse(row.best_for), row.id).toEqual([
        'Long-horizon agentic coding',
        'Multistep research',
        'Document, spreadsheet, and slide work',
      ]);
      expect(row.type, row.id).toBe('llm');
      expect(row.streaming, row.id).toBe('true');
      // Rule 8: every LLM row mirrors `vision` into the capabilities jsonb.
      expect(row.vision, row.id).toBe('true');
    }
  });

  it.each([true, false])(
    'preserves an existing is_enabled choice (ON CONFLICT: %s)',
    { timeout: 60_000 },
    async (enabled) => {
      const baseline = await baselineOrders();
      // A build that already knew the model wrote the row and the user toggled it.
      await db.query(
        `INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
         VALUES ($1, 'anthropic', 'Claude Fable 5.1', NULL, '[]', '{"type":"llm","streaming":true}', $2, $3)`,
        [ADDED_IDS.anthropic, baseline.anthropic.length + 1, enabled]
      );

      await runner.up(migrations);

      expect(
        (await db.query('SELECT is_enabled FROM models WHERE id = $1', [ADDED_IDS.anthropic]))
          .rows[0]
      ).toEqual({ is_enabled: enabled });
      // The refresh still overwrites the NULL tagline the stale row carried.
      expect(
        (await db.query('SELECT tagline FROM models WHERE id = $1', [ADDED_IDS.anthropic])).rows[0]
      ).toEqual({ tagline: 'For demanding reasoning and long-horizon agentic work' });

      if (typeof migration.up !== 'string') {
        throw new Error('Expected SQL migration');
      }
      // Rule 3 again on a second apply: the toggle survives a catalog refresh.
      await db.exec(migration.up);
      expect(
        (await db.query('SELECT is_enabled FROM models WHERE id = $1', [ADDED_IDS.anthropic]))
          .rows[0]
      ).toEqual({ is_enabled: enabled });
    }
  );

  it('rolls back cleanly: removes both rows and leaves sibling ordering untouched', {
    timeout: 60_000,
  }, async () => {
    const baseline = await baselineOrders();
    await runner.up(migrations);
    await runner.down(migrations, migration.version - 1);

    expect((await order('anthropic')).rows).toEqual(baseline.anthropic);
    expect((await order('bedrock')).rows).toEqual(baseline.bedrock);

    if (typeof migration.down !== 'string') {
      throw new Error('Expected SQL rollback');
    }
    // Rolling back again is a no-op, not a second mutation.
    await db.exec(migration.down);
    expect((await order('anthropic')).rows).toEqual(baseline.anthropic);
    expect((await order('bedrock')).rows).toEqual(baseline.bedrock);
  });
});
