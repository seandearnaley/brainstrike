import { DEFAULT_VIEW_FILTER_PRESETS } from '@brainstrike/types';
/**
 * Test for migration 027 (view_filter_presets table and seed data)
 * Verifies that the migration creates the table AND seeds default presets.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface ViewFilterPresetRow {
  description: string | null;
  excludes: string[];
  icon: string;
  id: string;
  includes: string[];
  is_default: boolean;
  name: string;
  sort_order: number;
  use_regex: boolean;
}

describe('View Filter Presets Migration (027)', () => {
  let db: PGlite;
  let runner: MigrationRunner;
  const TEST_TIMEOUT = 60_000;

  beforeEach(async () => {
    // The chain just before migration 027; each test runs 027 onward itself.
    db = await createDbAtVersion(26);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
  });

  it('should run all migrations including view_filter_presets', {
    timeout: TEST_TIMEOUT,
  }, async () => {
    await runner.up(migrations);

    // Verify migration 27 was applied
    const applied = await runner.getAppliedMigrations();
    expect(applied).toContain(27);

    // Verify the table exists
    const tableCheck = await db.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'view_filter_presets'
        ) AS exists
      `);
    expect((tableCheck.rows[0] as { exists: boolean }).exists).toBe(true);
  });

  it('should seed default view filter presets', { timeout: TEST_TIMEOUT }, async () => {
    await runner.up(migrations);

    // Query the seeded presets
    const result = await db.query<ViewFilterPresetRow>(`
        SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order
        FROM view_filter_presets
        ORDER BY sort_order
      `);

    expect(
      result.rows.map((row) => ({
        description: row.description,
        excludes: row.excludes,
        icon: row.icon,
        includes: row.includes,
        isDefault: row.is_default,
        name: row.name,
        sortOrder: row.sort_order,
        useRegex: row.use_regex,
      }))
    ).toEqual(DEFAULT_VIEW_FILTER_PRESETS);

    // Should have 7 default presets
    expect(result.rows.length).toBe(7);

    // Verify the preset names
    const names = result.rows.map((r) => r.name);
    expect(names).toEqual([
      'TypeScript/JavaScript',
      'All Code',
      'Documentation',
      'Config Files',
      'Styles',
      'Tests',
      'All Files',
    ]);

    // All should be marked as default
    for (const row of result.rows) {
      expect(row.is_default).toBe(true);
    }

    // Verify first preset has correct includes
    const tsPreset = result.rows[0];
    expect(tsPreset?.name).toBe('TypeScript/JavaScript');
    expect(tsPreset?.includes).toContain('*.ts');
    expect(tsPreset?.includes).toContain('*.tsx');
    expect(tsPreset?.excludes).toContain('node_modules');
  });

  it('should create indexes for view_filter_presets', { timeout: TEST_TIMEOUT }, async () => {
    await runner.up(migrations);

    const indexes = await db.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'view_filter_presets'
      `);

    const indexNames = indexes.rows.map((r) => (r as { indexname: string }).indexname);
    expect(indexNames).toContain('idx_view_filter_presets_sort_order');
    expect(indexNames).toContain('idx_view_filter_presets_is_default');
  });
});
