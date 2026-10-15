import { wasmLoader } from '@brainstrike/db';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import { onTestFinished } from 'vitest';

type TestPGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

function closeWhenTestFinishes(db: TestPGlite): TestPGlite {
  onTestFinished(async () => {
    // memory:// instances are not cached. The test owns the returned handle.
    if (db.closed) {
      return;
    }
    await db.close();
  });
  return db;
}

export async function createTestPGlite(dataDir: string): Promise<TestPGlite> {
  return closeWhenTestFinishes(await wasmLoader.createPGlite(dataDir));
}

/**
 * A migrated database — what every production caller of the assistant thread
 * repository holds (BST-1651).
 *
 * The repository used to CREATE its schema on first use, so a bare PGlite was
 * enough to test it; the same code path also made a fresh database diverge
 * silently from a migrated one. It now PROBES instead and throws
 * `AssistantMemorySchemaMissingError` when a relation is absent, so a suite
 * that wants working persistence has to migrate first — the same thing
 * `db-provider` does before any handle is handed out.
 *
 * Each call restores an isolated copy of a migrated snapshot instead of paying
 * `initdb` plus the whole migration chain again (`createMigratedTestDb`: once
 * per integration-lane run via its globalSetup, else once per test file). The
 * result is the database `wasmLoader.createPGlite('memory://…')` followed by
 * `migrate(db)` produces. `dataDir` must be an in-memory label; suites whose
 * subject is the migration or probe path build a bare `createTestPGlite` and
 * migrate it themselves.
 */
export async function createMigratedTestPGlite(dataDir: string): Promise<TestPGlite> {
  if (!dataDir.startsWith('memory://')) {
    throw new Error(
      `createMigratedTestPGlite restores in memory; got ${dataDir}. Use createTestPGlite and migrate() for an on-disk database.`
    );
  }
  return closeWhenTestFinishes(await createMigratedTestDb());
}
