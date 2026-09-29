import { expect, it } from 'vitest';
import { customMigrations } from '../src/drizzle/migrate.js';
import { baseMigrations, migrations } from '../src/migrations/index.js';
import type { Migration } from '../src/migrations/migration-runner.js';

// BST-1714. `packages/db/src/drizzle/migrate.ts` derives `customMigrations`
// straight from the numbered manifest and applies it in ARRAY order, so array
// position — not the `version` field — decides the production apply order.
// Biome's sort-imports rule keeps the import list above the array ordered;
// nothing enforced the array itself, and `main` shipped 123 ahead of 122.
// `MigrationRunner.runPending` sorts a copy by version, which is exactly why
// the numbered-runner tests could not see the drift.

interface OrderedEntry {
  readonly label: string;
  readonly version: number;
}

const toOrderedEntries = (source: readonly Migration[]): OrderedEntry[] =>
  source.map((migration) => ({ label: migration.name, version: migration.version }));

/**
 * Every adjacent pair that is not strictly ascending, each naming both sides so
 * a red run points straight at the offending entries instead of at a 130-line
 * array diff. Strict (`>=`) so a duplicated version fails too.
 */
function findOrderInversions(entries: readonly OrderedEntry[]): string[] {
  const inversions: string[] = [];
  let previous: OrderedEntry | undefined;
  for (const entry of entries) {
    if (previous !== undefined && previous.version >= entry.version) {
      inversions.push(
        `${previous.label} (version ${previous.version}) precedes ${entry.label} (version ${entry.version})`
      );
    }
    previous = entry;
  }
  return inversions;
}

it('keeps the numbered migration manifest strictly ascending by version', () => {
  expect(findOrderInversions(toOrderedEntries(migrations))).toEqual([]);
});

it('derives a strictly ascending production Drizzle apply order', () => {
  // The load-bearing assertion: this is the array `runMigrations` iterates.
  const derived = customMigrations.map((migration) => ({
    label: migration.name,
    version: Number(migration.version),
  }));
  expect(findOrderInversions(derived)).toEqual([]);
});

it('leaves the base migration array as exactly migrations 001-003', () => {
  // Guards the BST-1714 trap: this file holds a SECOND array, and a sorter that
  // spans both corrupts it. `baseMigrations` is the test-environment subset and
  // must stay the head of the numbered manifest, untouched by any reordering.
  expect(toOrderedEntries(baseMigrations)).toEqual([
    { label: 'initial_schema', version: 1 },
    { label: 'add_vector_columns', version: 2 },
    { label: 'add_performance_indexes', version: 3 },
  ]);
  expect(baseMigrations).toEqual(migrations.slice(0, baseMigrations.length));
});
