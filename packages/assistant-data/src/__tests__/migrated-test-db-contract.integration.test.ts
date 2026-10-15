import { MigrationRunner, migrate, migrations, wasmLoader } from '@brainstrike/db';
import {
  createMigratedTestDb,
  createNumberedChainTestDb,
} from '@brainstrike/db/test-support/migrated-test-db';
import { describe, expect, it, onTestFinished } from 'vitest';

type PGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

/**
 * Suites in this and other packages now restore a migrated snapshot instead of
 * migrating cold per test. That is only sound while a restored database is the
 * database the cold path builds, so this pins it against a real cold run.
 */

async function open(create: () => Promise<PGlite>): Promise<PGlite> {
  const db = await create();
  onTestFinished(async () => {
    if (!db.closed) {
      await db.close();
    }
  });
  return db;
}

/** Columns, indexes, constraints, extensions and the client plugin of a database. */
async function schemaFingerprint(db: PGlite): Promise<unknown> {
  const columns = await db.query(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name, ordinal_position`
  );
  const indexes = await db.query(
    `SELECT schemaname, tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY schemaname, tablename, indexname`
  );
  const constraints = await db.query(
    `SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE connamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
     ORDER BY relation, conname`
  );
  const extensions = await db.query(
    'SELECT extname, extversion FROM pg_extension ORDER BY extname'
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    extensions: extensions.rows,
    indexes: indexes.rows,
    live: typeof (db as PGlite & { live?: unknown }).live,
  };
}

describe('migrated test database snapshots', () => {
  it('restores what a cold migrate() builds, ledger included', async () => {
    const cold = await open(async () => {
      const db = await wasmLoader.createPGlite('memory://');
      await migrate(db);
      return db;
    });
    const restored = await open(createMigratedTestDb);

    const ledger = 'SELECT id, hash FROM "__drizzle_migrations" ORDER BY id';
    const coldLedger = (await cold.query(ledger)).rows;
    expect(coldLedger.length).toBeGreaterThan(0);
    expect((await restored.query(ledger)).rows).toEqual(coldLedger);
    expect(await schemaFingerprint(restored)).toEqual(await schemaFingerprint(cold));
  });

  it('restores what a cold numbered MigrationRunner chain builds, ledger included', async () => {
    const cold = await open(async () => {
      const db = await wasmLoader.createPGlite('memory://');
      const runner = new MigrationRunner(db);
      await runner.initialize();
      await runner.up(migrations);
      return db;
    });
    const restored = await open(createNumberedChainTestDb);

    const ledger = 'SELECT version, name, checksum FROM _migrations ORDER BY version';
    const coldLedger = (await cold.query(ledger)).rows;
    expect(coldLedger.length).toBe(migrations.length);
    expect((await restored.query(ledger)).rows).toEqual(coldLedger);
    expect(await schemaFingerprint(restored)).toEqual(await schemaFingerprint(cold));
  });

  it('hands every caller its own database', async () => {
    const first = await open(createMigratedTestDb);
    const second = await open(createMigratedTestDb);

    await first.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ('only-in-first', 'path', 'First', '/tmp/first', 'live', NOW())`
    );

    const rows = await second.query(`SELECT id FROM roots WHERE id = 'only-in-first'`);
    expect(rows.rows).toEqual([]);
  });
});
