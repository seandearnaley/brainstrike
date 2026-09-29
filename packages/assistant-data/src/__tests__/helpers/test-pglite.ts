import { migrate, wasmLoader } from '@brainstrike/db';
import { onTestFinished } from 'vitest';

type TestPGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

export async function createTestPGlite(dataDir: string): Promise<TestPGlite> {
  const db = await wasmLoader.createPGlite(dataDir);
  onTestFinished(async () => {
    // memory:// instances are not cached. The test owns the returned handle.
    if (db.closed) {
      return;
    }
    await db.close();
  });
  return db;
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
 * `migrate()` on an in-memory PGlite measures ~185ms (the ~800ms figure in
 * docs/agents/database.md is dominated by `initdb`, which these suites already
 * pay), so the snapshot machinery `packages/db` uses is not worth its
 * complexity here.
 */
export async function createMigratedTestPGlite(dataDir: string): Promise<TestPGlite> {
  const db = await createTestPGlite(dataDir);
  await migrate(db);
  return db;
}
