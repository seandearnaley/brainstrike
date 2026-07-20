import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { live } from '@electric-sql/pglite/live';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { inject } from 'vitest';
import { migrate } from '../../src/migrations/bootstrap.js';
import { wasmLoader } from '../../src/wasm-loader.js';

/**
 * Fast migrated PGlite for tests, via the template-snapshot pattern.
 *
 * The full 60-migration chain is the dominant cost of the db unit suite: a
 * cold `initdb + migrate` averages ~800ms, and the suite booted a fresh one
 * PER TEST (hundreds of times). Instead, `globalSetup` (db-snapshot-global.ts)
 * runs the migrations ONCE per vitest process and dumps the migrated data dir
 * to a tarball on disk; every test then `loadDataDir`s a fresh in-memory PGlite
 * from that tarball (~170ms — a measured ~4.8x per-boot speedup) with the full
 * engine-extension set. Each call still returns an ISOLATED instance, so the
 * per-test isolation guarantee is unchanged — only the cost is removed.
 *
 * This is the same memory-migrate → dump → load pattern the production browser
 * first-run bootstrap already relies on (see docs/agents/database.md § BROWSER
 * FIRST-RUN FAST BOOTSTRAP), applied to tests.
 *
 * Use this anywhere a test just needs "a migrated database". Do NOT use it in
 * tests that exercise the migration RUNNER itself (drizzle-migrate,
 * migration-runner, migration-integration): those must run migrations for real.
 */

/**
 * The engine-extension set every db PGlite construction site must load
 * (docs/agents/database.md § PGLITE EXTENSION INVARIANT). Declared once here so
 * every snapshot-loaded test instance is identical to the production loader.
 */
export const TEST_ENGINE_EXTENSIONS = {
  live,
  pg_textsearch: pgTextsearch,
  pg_trgm: pgTrgm,
  vector,
} as const;

/**
 * Module-scoped cache of the snapshot tarball bytes. With the unit project's
 * default `isolate: true` on the forks pool, each test FILE gets a fresh module
 * graph, so this is read from disk once per test file (not once per worker
 * process) — still negligible next to re-migrating, and every test in the file
 * then reuses the bytes.
 */
let cachedSnapshot: Uint8Array | null = null;

async function loadSnapshotBytes(): Promise<Uint8Array> {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const snapshotPath = inject('dbSnapshotPath');
  if (!snapshotPath) {
    throw new Error(
      'createMigratedTestDb requires the db snapshot globalSetup. Ensure the unit vitest project declares globalSetup: db-snapshot-global.ts.'
    );
  }
  cachedSnapshot = await readFile(snapshotPath);
  return cachedSnapshot;
}

/**
 * Returns a fresh, isolated, fully-migrated in-memory PGlite loaded from the
 * shared snapshot with the full engine-extension set. The caller owns the
 * instance and must `close()` it (existing suites already do so in afterEach).
 */
export async function createMigratedTestDb(): Promise<PGlite> {
  const bytes = await loadSnapshotBytes();
  // A fresh Blob view per call — PGlite consumes the tarball on construction.
  const db = new PGlite({
    extensions: TEST_ENGINE_EXTENSIONS,
    loadDataDir: new Blob([bytes]),
  });
  // Force readiness so callers observe a usable, migrated database synchronously
  // after the await (loadDataDir is applied during initialization).
  await db.query('SELECT 1');
  return db;
}

/**
 * Builds the migrated snapshot tarball. Runs ONCE per vitest process inside
 * `globalSetup`. Kept here (next to the loader) so the build and load paths
 * share the extension set and can never drift.
 */
export async function buildMigratedSnapshot(): Promise<Uint8Array> {
  const template = await wasmLoader.createPGlite('memory://');
  try {
    await migrate(template);
    // 'none' compression: the tarball lives on a local temp file read once per
    // worker, so decompression cost per load would outweigh the disk savings.
    const dump = await template.dumpDataDir('none');
    return new Uint8Array(await dump.arrayBuffer());
  } finally {
    await template.close();
  }
}
