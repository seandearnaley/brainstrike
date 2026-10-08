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
 * properly" error that the corruption classifier does not recognize.
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
  // version and let the normal initialization path handle it.
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
 * Whether an existing data directory was written by a NEWER Postgres engine major
 * than the one currently bundled (e.g. a PG19 dir under a PG18 build, after the
 * user rolls the app back to an older version). Downgrading the on-disk engine is
 * unsupported, but the newer data is still valid for a future re-upgrade — so such
 * a dir must be left UNTOUCHED (fail loudly) rather than wiped or moved aside. This
 * mirrors the browser reclaim's forward-only `< currentMajor` guard so neither
 * platform can silently destroy data a newer build owns. A non-numeric/garbage
 * version is treated as "not newer" so it falls through to the normal wipe path.
 */
export function isNewerPgDataDir(
  dataDir: string,
  bundledMajor: string = BUNDLED_PG_MAJOR
): boolean {
  const major = readPgDataMajor(dataDir);
  if (major === null) {
    return false;
  }
  const found = Number(major);
  const bundled = Number(bundledMajor);
  if (!(Number.isFinite(found) && Number.isFinite(bundled))) {
    return false;
  }
  return found > bundled;
}

/**
 * Reclaim engine-upgrade backups (`<dataDir>.pre-pg*.bak` siblings) older than
 * `retentionMs`, so a moved-aside old database doesn't sit on disk forever and
 * compound across major bumps. Best-effort and side-effect-tolerant: unreadable
 * entries are skipped, and the just-created backup (mtime ≈ now) is never swept.
 * Returns the paths that were removed.
 *
 * `excludePath` is a backup that must NEVER be pruned regardless of its mtime —
 * pass the backup created earlier in THIS boot. The retention clock relies on the
 * backup's mtime being stamped to move-time, but that stamp is best-effort
 * (`utimesSync` can throw); if it didn't take, the backup keeps the old DB's last
 * write mtime, which after a long idle period can already exceed `retentionMs`.
 * Without this exclusion the same-boot prune would then delete the fresh backup
 * immediately, collapsing the recovery window to zero. The exclusion makes
 * same-boot survival deterministic and independent of whether the stamp succeeded.
 */
export function pruneStaleEngineUpgradeBackups(
  dataDir: string,
  retentionMs: number = ENGINE_UPGRADE_BACKUP_RETENTION_MS,
  now: number = Date.now(),
  excludePath: string | null = null
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
    // Never sweep the backup created this boot — its mtime may predate retention
    // if the move-time stamp failed. Compare via path.resolve() rather than raw
    // string equality: the caller builds excludePath by string concat while these
    // candidates come from path.join, which are equal on POSIX but not guaranteed
    // byte-equal across separators/normalization (e.g. Windows). Normalizing both
    // keeps the exclusion (and thus the recovery window) robust cross-platform.
    if (excludePath !== null && path.resolve(full) === path.resolve(excludePath)) {
      continue;
    }
    try {
      if (now - statSync(full).mtimeMs > retentionMs) {
        rmSync(full, { force: true, recursive: true });
        pruned.push(full);
      }
    } catch {
      // best-effort: skip entries we can't stat or remove
    }
  }

  return pruned;
}

// Postgres names a WAL segment with 24 upper-case hex digits (timeline, log, segment).
const PG_WAL_SEGMENT_RE = /^[0-9A-F]{24}$/u;

/**
 * Bytes of WAL segment files in `<dataDir>/pg_wal`: an O(1) upper bound of what crash recovery
 * must replay when the database opens. Recycled segments count too, which can only make a
 * budget derived from this larger. A missing directory is a database that was never created:
 * 0. Any other failure to read it throws; it is never reported as 0, which would hand the open
 * the smallest possible deadline.
 */
export function readPgWalBytes(dataDir: string): number {
  const walDir = path.join(dataDir, 'pg_wal');
  let names: string[];
  try {
    names = readdirSync(walDir);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  let bytes = 0;
  for (const name of names) {
    if (PG_WAL_SEGMENT_RE.test(name)) {
      bytes += statSync(path.join(walDir, name)).size;
    }
  }
  return bytes;
}
