/**
 * The migration chain must reproduce, exactly, what `MASTRA_MEMORY_SCHEMA_SQL`
 * creates on a bare database (BST-1651).
 *
 * `@brainstrike/assistant-contract` remains the AUTHORITY for this DDL: it is
 * what `PgliteMemoryStore.initialize()` executes, which is Mastra's own storage
 * contract. Migration 117 carries a LITERAL copy rather than importing the
 * constant, because `deriveCustomMigrations()` reads `migration.up` during
 * module-scope evaluation and importing it there would reintroduce the BST-558
 * chunk-initialization hazard that `scripts/verify-mastra-schema-init-order.mjs`
 * guards — an uninitialized binding does not throw, it splices the literal
 * string "undefined" into a migration.
 *
 * So the copy is pinned HERE, at the catalog level rather than by string
 * equality: build both databases for real and compare every relation, column,
 * index and constraint the contract creates. That oracle stays honest across a
 * future @mastra/memory schema change — the delta arrives as a NEW forward
 * migration (a shipped migration is never amended in place) and this test goes
 * green again once the chain carries it, whereas a string comparison against
 * migration 117 could only ever be satisfied by editing shipped SQL.
 */
import {
  MASTRA_BACKGROUND_TASKS_SCHEMA_SQL,
  MASTRA_MEMORY_SCHEMA_SQL,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb, TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db';

interface CatalogSnapshot {
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
  readonly indexes: readonly string[];
}

const COLUMNS_SQL = `
  SELECT table_name || '.' || column_name || ' ' || data_type
       || ' nullable=' || is_nullable
       || ' default=' || COALESCE(column_default, '-') AS entry
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name LIKE 'mastra\\_%'
  ORDER BY entry`;

const INDEXES_SQL = `
  SELECT indexdef AS entry
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename LIKE 'mastra\\_%'
  ORDER BY entry`;

const CONSTRAINTS_SQL = `
  SELECT rel.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid) AS entry
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public' AND rel.relname LIKE 'mastra\\_%'
  ORDER BY entry`;

async function snapshotMastraCatalog(db: PGlite): Promise<CatalogSnapshot> {
  const columns = await db.query<{ entry: string }>(COLUMNS_SQL);
  const indexes = await db.query<{ entry: string }>(INDEXES_SQL);
  const constraints = await db.query<{ entry: string }>(CONSTRAINTS_SQL);
  return {
    columns: columns.rows.map((row) => row.entry),
    constraints: constraints.rows.map((row) => row.entry),
    indexes: indexes.rows.map((row) => row.entry),
  };
}

describe('Mastra memory schema: contract DDL vs the migration chain', () => {
  let contractDb: PGlite;
  let migratedDb: PGlite;

  beforeEach(async () => {
    contractDb = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
    await contractDb.waitReady;
    await contractDb.exec(MASTRA_MEMORY_SCHEMA_SQL);
    await contractDb.exec(MASTRA_BACKGROUND_TASKS_SCHEMA_SQL);
    migratedDb = await createMigratedTestDb();
  });

  afterEach(async () => {
    await contractDb.close();
    await migratedDb.close();
  });

  it('creates the same relations, columns, indexes and constraints', async () => {
    const contract = await snapshotMastraCatalog(contractDb);
    const migrated = await snapshotMastraCatalog(migratedDb);

    // Control: an empty scrape would make every assertion below vacuous.
    expect(contract.columns.length).toBeGreaterThan(40);
    expect(contract.indexes.length).toBeGreaterThan(4);

    // Subset, not equality: the migrated database legitimately carries more
    // (`mastra_workflow_snapshot` is created by Mastra's workflow storage and
    // is outside this contract). Anything the contract creates and the chain
    // does not is drift, and drift is what this test exists to catch.
    for (const entry of contract.columns) {
      expect(migrated.columns, `column missing from the migration chain: ${entry}`).toContain(
        entry
      );
    }
    for (const entry of contract.indexes) {
      expect(migrated.indexes, `index missing from the migration chain: ${entry}`).toContain(entry);
    }
    for (const entry of contract.constraints) {
      expect(migrated.constraints, `constraint missing from the chain: ${entry}`).toContain(entry);
    }
  });

  it('leaves the contract DDL a no-op on a migrated database', async () => {
    const before = await snapshotMastraCatalog(migratedDb);
    await migratedDb.exec(MASTRA_MEMORY_SCHEMA_SQL);
    const after = await snapshotMastraCatalog(migratedDb);

    // `PgliteMemoryStore.initialize()` still executes this on every store it
    // stands up, including against the migrated production database. It must
    // change nothing there.
    expect(after).toEqual(before);
  });
});
