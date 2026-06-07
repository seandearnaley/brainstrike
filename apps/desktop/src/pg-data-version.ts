import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Suffix used for a data dir moved aside during an engine-major upgrade
 * (`<dataDir>.pre-pg<new>-from-pg<old>.bak`). See db-main's upgrade guard.
 */
export const ENGINE_UPGRADE_BACKUP_SUFFIX = '.bak';

/**
 * How long a moved-aside upgrade backup is retained before it is reclaimed. The
 * old dir can't be opened by the bundled engine — it's forensic insurance only —
 * so it is swept on a later successful boot once the window has elapsed.
 */
export const ENGINE_UPGRADE_BACKUP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const ENGINE_UPGRADE_BACKUP_RE = /\.pre-pg\d+-from-pg[^/\\]*\.bak$/;

/**
 * Whether a name is an engine-upgrade moved-aside backup
 * (`<base>.pre-pg<new>-from-pg<old>.bak`). Used to exclude these (unopenable,
 * forensic-only) dirs from profile reset-backup copies so they aren't duplicated
 * into every snapshot taken during the retention window.
 */
export function isEngineUpgradeBackupName(name: string): boolean {
  return ENGINE_UPGRADE_BACKUP_RE.test(name);
}

/**
 * Postgres engine major bundled with the current PGlite release.
 *
 * PGlite 0.5 ships Postgres 18. A PG major upgrade changes the on-disk catalog
 * format, so a data directory written by an older engine (PG17 under PGlite 0.4)
 * cannot be opened by the new engine — PGlite fails with a generic
 * "failed to initialize properly" error that the corruption-recovery path does
 * not classify as recoverable.
 *
 * Bump this whenever the bundled PGlite ships a new Postgres major — and keep it
 * in lockstep with `PGLITE_DATA_DIR_VERSION` in
 * packages/db/src/browser-pglite-storage.ts (which also documents appending the
 * superseded versioned name to the factory-reset fallback list).
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

/**
 * Reclaim engine-upgrade backups (`<dataDir>.pre-pg*.bak` siblings) older than
 * `retentionMs`, so a moved-aside old database doesn't sit on disk forever and
 * compound across major bumps. Best-effort and side-effect-tolerant: unreadable
 * entries are skipped, and the just-created backup (mtime ≈ now) is never swept.
 * Returns the paths that were removed.
 */
export function pruneStaleEngineUpgradeBackups(
  dataDir: string,
  retentionMs: number = ENGINE_UPGRADE_BACKUP_RETENTION_MS,
  now: number = Date.now()
): string[] {
  const parent = path.dirname(dataDir);
  const prefix = `${path.basename(dataDir)}.pre-pg`;
  const pruned: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return pruned;
  }

  for (const name of entries) {
    if (!(name.startsWith(prefix) && name.endsWith(ENGINE_UPGRADE_BACKUP_SUFFIX))) {
      continue;
    }
    const full = path.join(parent, name);
    try {
      if (now - statSync(full).mtimeMs > retentionMs) {
        rmSync(full, { recursive: true, force: true });
        pruned.push(full);
      }
    } catch {
      // best-effort: skip entries we can't stat or remove
    }
  }

  return pruned;
}
