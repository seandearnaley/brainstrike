import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('production migration authority guard', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite();
  });

  afterEach(async () => {
    await db.close();
  });

  it('initializes an empty database with only the production migration ledger', async () => {
    await migrate(db);

    const ledgers = await db.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('_migrations', '__drizzle_migrations')
      ORDER BY tablename
    `);

    expect(ledgers.rows.map((row) => row.tablename)).toEqual(['_migrations']);
  });

  it('refuses to run legacy production migrations over a Drizzle-ledger database', async () => {
    await db.query(`
      CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      )
    `);

    await expect(migrate(db)).rejects.toThrow(
      'Drizzle migration ledger "__drizzle_migrations" exists without an explicit migration bridge.'
    );

    const productionLedger = await db.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = '_migrations'
    `);
    expect(productionLedger.rows[0]?.count).toBe(0);
  });
});
