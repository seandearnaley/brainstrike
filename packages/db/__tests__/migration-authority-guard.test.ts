import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { wasmLoader } from '../src/wasm-loader.js';

// Real PGlite migration runs exceed the unit project's 10s testTimeout on
// loaded CI runners; match the package's migration-test timeout.
const MIGRATION_RUN_TIMEOUT_MS = 30_000;

describe('production migration authority guard', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite();
  });

  afterEach(async () => {
    await db.close();
  });

  it(
    'initializes an empty database with only the Drizzle production migration ledger',
    async () => {
      await migrate(db);

      const ledgers = await db.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('_migrations', '__drizzle_migrations')
      ORDER BY tablename
    `);

      expect(ledgers.rows.map((row) => row.tablename)).toEqual(['__drizzle_migrations']);
    },
    MIGRATION_RUN_TIMEOUT_MS
  );

  it(
    'refuses to run greenfield Drizzle migrations over a legacy-ledger database',
    async () => {
      await db.query(`
      CREATE TABLE "_migrations" (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      )
    `);
      await expect(migrate(db)).rejects.toThrow(
        'Brainstrike DB is greenfield; legacy "_migrations" databases must be reset instead of migrated.'
      );

      const drizzleLedger = await db.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = '__drizzle_migrations'
    `);
      expect(drizzleLedger.rows[0]?.count).toBe(0);
    },
    MIGRATION_RUN_TIMEOUT_MS
  );
});
