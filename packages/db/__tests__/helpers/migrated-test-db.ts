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
 * Schema construction is the dominant cost of the db unit suite: a cold
 * `initdb + migrate` costs seconds, and the suite booted a fresh one PER TEST
 * (hundreds of times). Instead, `globalSetup` (db-snapshot-global.ts) migrates
 * ONCE per vitest process and dumps the migrated data dir to a tarball on disk;
 * every test then `loadDataDir`s a fresh in-memory PGlite from that tarball (a
 * measured ~4-5x per-boot speedup) with the full engine-extension set. Each call
 * still returns an ISOLATED instance, so the per-test isolation guarantee is
 * unchanged — only the cost is removed.
 *
 * This is the same memory-migrate → dump → load pattern the production browser
 * first-run bootstrap already relies on (see docs/agents/database.md § BROWSER
 * FIRST-RUN FAST BOOTSTRAP), applied to tests.
 *
 * Use this anywhere a test just needs "a migrated database". Do NOT use it in
 * tests whose subject is schema construction itself (the current-schema catalog
 * test, drizzle-migrate, migration-runner and the drizzle ledger suites): those
 * must boot from an empty cluster for real.
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

export interface RestoredTestDbOptions {
  /**
   * Restore onto this NodeFS data directory instead of memory. Only for tests
   * that genuinely need on-disk behavior (close and reopen the same directory);
   * the caller owns the directory (`createPGliteTestDataDir` cleans it up).
   */
  readonly dataDir?: string | undefined;
}

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

async function restoreSnapshot(
  bytes: Uint8Array,
  options: RestoredTestDbOptions = {}
): Promise<PGlite> {
  // A fresh Blob view per call — PGlite consumes the tarball on construction.
  const db = new PGlite({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    extensions: TEST_ENGINE_EXTENSIONS,
    loadDataDir: new Blob([bytes]),
  });
  // Force readiness so callers observe a usable, migrated database synchronously
  // after the await (loadDataDir is applied during initialization).
  await db.query('SELECT 1');
  return db;
}

async function dumpSnapshot(template: PGlite): Promise<Uint8Array> {
  // 'none' compression: the tarball is restored many times per file, so
  // decompression cost per load would outweigh the memory savings.
  const dump = await template.dumpDataDir('none');
  return new Uint8Array(await dump.arrayBuffer());
}

/**
 * Returns a fresh, isolated, fully-migrated PGlite loaded from the shared
 * snapshot with the full engine-extension set (in memory unless
 * `options.dataDir` is given). The caller owns the instance and must `close()`
 * it (existing suites already do so in afterEach).
 */
export async function createMigratedTestDb(options?: RestoredTestDbOptions): Promise<PGlite> {
  return await restoreSnapshot(await loadSnapshotBytes(), options);
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
    return await dumpSnapshot(template);
  } finally {
    await template.close();
  }
}
