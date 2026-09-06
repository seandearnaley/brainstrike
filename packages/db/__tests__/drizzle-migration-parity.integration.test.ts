import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

// Shrink-only allowlist: entries may be removed, never added. New drift between
// the runners must fail this test. These three items pre-date BST-1643; freeze
// individual columns so adding a column to an allowed table still fails.
const KNOWN_RUNNER_DIVERGENCE = {
  drizzleOnly: {
    embedding_cache: [
      'access_count',
      'accessed_at',
      'content_hash',
      'created_at',
      'dimensions',
      'embedding',
      'id',
      'model_key',
    ],
    token_cache: ['content_hash', 'created_at', 'file_path', 'id', 'token_count'],
  },
  numberedOnly: {
    file_records: ['embedding'],
  },
} as const;

it('creates the same application relations and columns through both migration runners', async () => {
  const drizzleDb = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  const numberedDb = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  try {
    await expect(runMigrations(drizzleDb)).resolves.toMatchObject({ success: true });
    const runner = new MigrationRunner(numberedDb);
    await runner.initialize();
    await runner.up(migrations);

    // The two runners deliberately own different bookkeeping tables.
    const relationColumns = `
      SELECT table_name || '.' || column_name AS key
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name NOT IN ('_migrations', '__drizzle_migrations')
      ORDER BY table_name, column_name
    `;
    const drizzleColumns = (await drizzleDb.query<{ key: string }>(relationColumns)).rows.map(
      (row) => row.key
    );
    const numberedColumns = (await numberedDb.query<{ key: string }>(relationColumns)).rows.map(
      (row) => row.key
    );
    const drizzleSet = new Set(drizzleColumns);
    const numberedSet = new Set(numberedColumns);
    const knownDrizzleOnly = new Set(
      Object.entries(KNOWN_RUNNER_DIVERGENCE.drizzleOnly).flatMap(([table, columns]) =>
        columns.map((column) => `${table}.${column}`)
      )
    );
    const knownNumberedOnly = new Set(
      Object.entries(KNOWN_RUNNER_DIVERGENCE.numberedOnly).flatMap(([table, columns]) =>
        columns.map((column) => `${table}.${column}`)
      )
    );

    // Keep strict equality for every column outside the frozen divergences.
    expect(drizzleColumns.length).toBeGreaterThan(0);
    expect(drizzleColumns.filter((column) => !knownDrizzleOnly.has(column))).toEqual(
      numberedColumns.filter((column) => !knownNumberedOnly.has(column))
    );

    // No stale exemptions: every frozen item must still be a one-sided difference.
    // A reconciliation must remove its entry rather than silently retaining it.
    expect(drizzleColumns.filter((column) => !numberedSet.has(column))).toEqual(
      [...knownDrizzleOnly].sort()
    );
    expect(numberedColumns.filter((column) => !drizzleSet.has(column))).toEqual(
      [...knownNumberedOnly].sort()
    );
  } finally {
    await drizzleDb.close();
    await numberedDb.close();
  }
}, 30_000);
