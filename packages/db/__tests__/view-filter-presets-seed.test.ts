import { DEFAULT_VIEW_FILTER_PRESETS } from '@brainstrike/types';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

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

/**
 * The seeded view-filter presets must still match the TypeScript source of
 * truth in `@brainstrike/types`.
 *
 * Was migration-027's suite. Dropped: "runs all migrations including 027" and
 * the index assertions -- the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt pins every index, and after the
 * collapse to one current-schema DDL (ADR-0020) there is no per-migration ledger
 * entry to assert.
 *
 * Deliberately KEPT, and not redundant: the fixture pins what the DATABASE
 * holds, but nothing in it checks that those rows still agree with
 * `DEFAULT_VIEW_FILTER_PRESETS`. This is a cross-source parity assertion -- the
 * seed and the shipped constant drifting apart is exactly the failure it
 * catches, and the fixture would happily record the drifted rows.
 *
 * Note the presets' `id` and timestamps are NOT compared: the seed leaves
 * `uuidv7()` and `now()` to fire per install, so they are particular to the
 * database that was built.
 */
describe('view filter presets seed', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('matches the shipped DEFAULT_VIEW_FILTER_PRESETS exactly, in order', async () => {
    const result = await db.query<ViewFilterPresetRow>(
      `SELECT id, name, description, icon, includes, excludes, use_regex, is_default, sort_order
       FROM view_filter_presets
       ORDER BY sort_order`
    );

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
  });

  it('gives every preset a distinct install-time id (the seed leaves uuidv7() to fire)', async () => {
    const result = await db.query<{ id: string }>('SELECT id FROM view_filter_presets');

    const ids = result.rows.map((row) => row.id);
    expect(ids).toHaveLength(DEFAULT_VIEW_FILTER_PRESETS.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
});
