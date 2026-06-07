import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

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
 * Postgres engine major bundled with the current PGlite release (e.g. '18').
 *
 * MUST stay in lockstep with `PGLITE_DATA_DIR_VERSION` ('pg18') in
 * packages/db/src/browser-pglite-storage.ts. It is redeclared here (rather than
 * imported) because the Electron MAIN process is deliberately isolated from
 * `@brainstrike/db` (tsconfig.main uses classic resolution with no db path, so
 * the main bundle never pulls in renderer/PGlite code). Drift is guarded by the
 * cross-package test `pg-engine-major-sync.test.ts`. A PG major upgrade changes
 * the on-disk catalog format, so a data dir written by an older engine cannot be
 * opened by the new one — PGlite fails with a generic "failed to initialize
 * properly" error that corruption-recovery does not classify as recoverable.
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
    // Scope to THIS data dir's backups (prefix) AND reuse the canonical predicate
    // so a loose sibling like `pgdata.pre-pgfoo.bak` is not swept.
    if (!(name.startsWith(prefix) && isEngineUpgradeBackupName(name))) {
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
