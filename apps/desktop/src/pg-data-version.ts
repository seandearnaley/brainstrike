import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Postgres engine major bundled with the current PGlite release.
 *
 * PGlite 0.5 ships Postgres 18. A PG major upgrade changes the on-disk catalog
 * format, so a data directory written by an older engine (PG17 under PGlite 0.4)
 * cannot be opened by the new engine — PGlite fails with a generic
 * "failed to initialize properly" error that the corruption-recovery path does
 * not classify as recoverable.
 *
 * Bump this whenever the bundled PGlite ships a new Postgres major.
 */
export const BUNDLED_PG_MAJOR = '18';

/**
 * Read the Postgres major version recorded in a data directory's `PG_VERSION`
 * file. Returns `null` when the directory has no `PG_VERSION` (a fresh/empty
 * directory that has never been initialized).
 */
export function readPgDataMajor(dataDir: string): string | null {
  const versionFile = path.join(dataDir, 'PG_VERSION');
  if (!existsSync(versionFile)) {
    return null;
  }
  // An empty / whitespace-only PG_VERSION means the directory is mid-init or
  // corrupt — it is NOT evidence of a different engine major, so report no
  // version and let the normal init/corruption-recovery path handle it.
  const major = readFileSync(versionFile, 'utf8').trim();
  return major.length > 0 ? major : null;
}

/**
 * Determine whether an existing data directory was written by a different
 * Postgres engine major than the one currently bundled, and therefore cannot be
 * opened. A missing/fresh directory is compatible (there is nothing to migrate).
 *
 * Greenfield policy: when this returns true the caller wipes the directory and
 * starts fresh rather than attempting an on-disk upgrade.
 */
export function isIncompatiblePgDataDir(
  dataDir: string,
  expectedMajor: string = BUNDLED_PG_MAJOR
): boolean {
  const major = readPgDataMajor(dataDir);
  return major !== null && major !== expectedMajor;
}
