import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import type { Migration } from '../src/migrations/migration-runner.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const DELISTED_IDS = [
  'inclusionai/ling-3.0-flash:free',
  'kwaipilot/kat-coder-air-v2.5',
  'qwen/qwen3.8-max',
  'stealth/ox-alpha',
] as const;

interface OrderedModel {
  id: string;
  provider_id: string;
  sort_order: number;
}

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

function getMigration121(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 121);
  if (!migration) {
    throw new Error('Migration 121 is missing');
  }
  return migration;
}

describe('migration 121 retire delisted OpenRouter models', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  /** A fresh copy of the numbered chain through `version` (see createDbAtVersion). */
  async function openAtVersion(version: number): Promise<void> {
    db = await createDbAtVersion(version);
    runner = new MigrationRunner(db);
  }

  afterEach(async () => {
    // A test that failed before opening its database left the previous one closed.
    if (db && !db.closed) {
      await db.close();
    }
  });

  async function readOrdering(providerId: string): Promise<OrderedModel[]> {
    const result = await db.query<OrderedModel>(
      `SELECT id, provider_id, sort_order
       FROM models
       WHERE provider_id = $1
       ORDER BY sort_order, id`,
      [providerId]
    );
    return result.rows;
  }

  async function readDelisted(): Promise<CatalogRow[]> {
    const result = await db.query<CatalogRow>(
      `SELECT id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled
       FROM models
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[...DELISTED_IDS]]
    );
    return result.rows;
  }

  /** Everything about a row except its position, which `down` cannot restore. */
  async function readDelistedIdentity(): Promise<Omit<CatalogRow, 'sort_order'>[]> {
    return (await readDelisted()).map(({ sort_order: _unused, ...identity }) => identity);
  }

  it('is registered as numbered migration 121', () => {
    expect(getMigration121().name).toBe('retire_delisted_openrouter_models');
    expect(getMigration121().ledgerKey).toBe('custom-121-retire-delisted-openrouter-models');
  });

  it('deletes exactly the four delisted routes, closes the sort_order gaps they leave, leaves other providers untouched, and round-trips', {
    timeout: 120_000,
  }, async () => {
    await openAtVersion(119);

    const before = await readOrdering('openrouter');
    const anthropicBefore = await readOrdering('anthropic');
    expect(before.map((row) => row.id)).toEqual(expect.arrayContaining([...DELISTED_IDS]));
    const survivors = before
      .filter((row) => !DELISTED_IDS.includes(row.id as (typeof DELISTED_IDS)[number]))
      .map((row) => row.id);

    const delistedBefore = await readDelistedIdentity();
    expect(delistedBefore).toHaveLength(DELISTED_IDS.length);

    await runner.runMigration(getMigration121());

    expect(await readDelisted()).toEqual([]);

    const after = await readOrdering('openrouter');
    // Relative order is preserved and the four gaps are closed: 1..N with no
    // holes, which a hard-coded ±1 shift could not produce for four
    // scattered deletions.
    expect(after.map((row) => row.id)).toEqual(survivors);
    expect(after.map((row) => row.sort_order)).toEqual(
      Array.from({ length: survivors.length }, (_unused, index) => index + 1)
    );
    // The partitioned renumber is a no-op for every provider this migration
    // does not delete from.
    expect(await readOrdering('anthropic')).toEqual(anthropicBefore);

    // Test-only rollback restores every row exactly as it stood before the
    // deletion — name, tagline, best_for and capabilities — so the numbered
    // runner round-trips. Comparing against the values captured at runtime
    // (rather than literals retyped from migrations 071/072/098/107) is what
    // makes a wrong value in `down` fail here.
    await runner.down(migrations, 119);
    expect(await readDelistedIdentity()).toEqual(delistedBefore);

    const rolledBack = await readOrdering('openrouter');
    expect(rolledBack).toHaveLength(before.length);
    expect(rolledBack.map((row) => row.sort_order)).toEqual(
      Array.from({ length: before.length }, (_unused, index) => index + 1)
    );
  });

  it('deletes only the rows a profile actually holds, without shifting by a fixed offset', {
    timeout: 120_000,
  }, async () => {
    await openAtVersion(119);

    // A profile that never received two of the four (they were removed out
    // of band). A ±4 shift would corrupt this ordering; the set-based
    // renumber does not.
    await db.query('DELETE FROM models WHERE id = ANY($1::text[])', [
      ['stealth/ox-alpha', 'qwen/qwen3.8-max'],
    ]);
    const survivors = (await readOrdering('openrouter'))
      .filter((row) => !DELISTED_IDS.includes(row.id as (typeof DELISTED_IDS)[number]))
      .map((row) => row.id);

    await runner.runMigration(getMigration121());

    const after = await readOrdering('openrouter');
    expect(after.map((row) => row.id)).toEqual(survivors);
    expect(after.map((row) => row.sort_order)).toEqual(
      Array.from({ length: survivors.length }, (_unused, index) => index + 1)
    );
  });
});
