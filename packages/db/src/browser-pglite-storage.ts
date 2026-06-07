export type BrowserPGliteStorageBackend = 'idb' | 'opfs-ahp';

export type BrowserPGliteStorageSelectionReason =
  | 'pglite-recommends-indexeddb'
  | 'requested-indexeddb'
  | 'requested-opfs-ahp-supported'
  | 'requested-opfs-ahp-unavailable';

export interface BrowserPGliteStorageSupport {
  readonly hasOpfsDirectory?: boolean;
  readonly hasWorker?: boolean;
  readonly requestedStorage?: BrowserPGliteStorageBackend | null;
}

export interface BrowserPGliteStorageSelection {
  readonly dataDir: string;
  readonly reason: BrowserPGliteStorageSelectionReason;
  readonly storage: BrowserPGliteStorageBackend;
}

const DEFAULT_BROWSER_DB_NAME = 'app';

/**
 * Persistent PGlite data directories are tagged with the embedded Postgres engine
 * major. A PG major upgrade (e.g. 17 -> 18 in PGlite 0.5) changes the on-disk
 * format, so reusing an unversioned directory across majors fails to initialize.
 * Bumping this token forces a clean, greenfield directory per engine major.
 *
 * THIS MUST TRACK THE ENGINE `@electric-sql/pglite` BUNDLES. Bump it whenever the
 * pinned pglite dependency moves to a release shipping a new Postgres major — not
 * just when you "feel like" versioning. If it lags the engine, a fresh install
 * writes a higher `PG_VERSION` than this constant, the desktop guard treats it as
 * "newer", and `reconcileIncompatiblePgDataDir` throws on every boot. The
 * `pglite-engine-major.integration.test.ts` anchor (which opens a real PGlite
 * handle and compares its server-version major to `PGLITE_ENGINE_MAJOR`) fails CI
 * if this drifts, so a forgotten bump is caught before release rather than in the
 * field.
 *
 * WHEN BUMPING THIS (e.g. to 'pg19'):
 * 1. Append the just-superseded versioned name(s) (e.g. `app-pg18`, `web-pg18`)
 *    to `FALLBACK_INDEXED_DB_NAMES` in
 *    packages/preferences/src/settings/system/factory-reset-helpers.ts. On
 *    browsers without `indexedDB.databases()` / OPFS `keys()` enumeration
 *    (older Safari/Firefox), `reclaimLegacyBrowserPGliteStorage` can only delete
 *    the unversioned base name, so the prior major's orphan is reclaimed solely
 *    via that maintained fallback list.
 * 2. Bump `BUNDLED_PG_MAJOR` in apps/desktop/src/pg-data-version.ts to match.
 */
export const PGLITE_DATA_DIR_VERSION = 'pg18';

function withEngineVersion(dbName: string): string {
  return `${dbName}-${PGLITE_DATA_DIR_VERSION}`;
}

export function getDefaultBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `idb://${withEngineVersion(dbName)}`;
}

export function getOpfsAhpBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `opfs-ahp://${withEngineVersion(dbName)}`;
}

/**
 * Current embedded Postgres engine major (e.g. 18), parsed from the version token.
 * Exported so an integration test can anchor it to the major actually reported by
 * an opened PGlite handle — closing the loop so this constant (and, via the
 * cross-package drift test, desktop's `BUNDLED_PG_MAJOR`) can't silently fall out
 * of step with the engine `@electric-sql/pglite` bundles.
 */
export const PGLITE_ENGINE_MAJOR = Number(PGLITE_DATA_DIR_VERSION.replace(/^pg/, ''));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a storage name is an OLDER same-base variant safe to reclaim: the
 * unversioned base (the original pre-versioning store) or any `-pg<N>` variant
 * with N strictly less than the current engine major. Matching every *older*
 * major (not just the immediately-previous suffix) keeps reclamation correct
 * across repeated bumps, while the `< current` gate means an older build never
 * background-deletes a NEWER build's `-pg<N+>` data (which a later re-upgrade
 * could still reopen) — reclaim only ever moves forward.
 */
function isReclaimableLegacyName(name: string, baseName: string, currentMajor: number): boolean {
  const match = name.match(new RegExp(`^${escapeRegExp(baseName)}(?:-pg(\\d+))?$`));
  if (!match) {
    return false;
  }
  const major = match[1];
  // Unversioned base = the original (oldest) store; always reclaimable.
  return major === undefined || Number(major) < currentMajor;
}

async function legacyIndexedDbNamesToReclaim(
  baseName: string,
  currentMajor: number
): Promise<string[]> {
  if (typeof indexedDB === 'undefined') {
    return [];
  }
  // Enumerate when supported so every older-major orphan is reclaimed, not just
  // the one whose suffix we can derive from the current name.
  if (typeof indexedDB.databases === 'function') {
    const infos = await indexedDB.databases();
    return infos
      .map((info) => info.name)
      .filter((name): name is string => typeof name === 'string')
      .filter((name) => isReclaimableLegacyName(name, baseName, currentMajor));
  }
  // Enumeration unavailable (older Safari/Firefox): best-effort delete the
  // unversioned base name (always older). Prior versioned majors can't be
  // discovered here; the maintained factory-reset fallback list is the
  // secondary cleanup path.
  return [baseName];
}

/**
 * OPFS layout (verified against @electric-sql/pglite@0.5.1, dist/fs/opfs-ahp.js):
 * a data dir `opfs-ahp://app-pg18` has its scheme stripped to `app-pg18`
 * (`dataDir.slice(11)` in index.js) and the OPFS-AHP FS resolves that bare name as
 * a single directory handle directly under the OPFS root
 * (`root.getDirectoryHandle('app-pg18', { create: true })` in its `init`). The
 * engine's per-DB files (`state.txt`, the `data/` pool) live INSIDE that named
 * dir. So each `-pg<N>` major is a distinct top-level root entry, and
 * `root.removeEntry(name, { recursive: true })` reclaims an older major's entire
 * tree in one call. (Our dbName has no `/`, so the name is always a single
 * top-level segment.)
 */
async function reclaimLegacyOpfsDirs(baseName: string, currentMajor: number): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return;
  }
  const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
    keys?: () => AsyncIterable<string>;
  };
  // Enumerate root entries when supported; otherwise fall back to the base name.
  const names: string[] = [];
  if (typeof root.keys === 'function') {
    for await (const name of root.keys()) {
      if (isReclaimableLegacyName(name, baseName, currentMajor)) {
        names.push(name);
      }
    }
  } else {
    names.push(baseName);
  }
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch {
      // best-effort: a single stuck entry (e.g. a handle still held by another
      // tab) must not abort reclaiming the remaining variants.
    }
  }
}

/**
 * Best-effort reclamation of legacy (pre-/other-engine-version) browser storage
 * for the same database base name, run once after the versioned database opens.
 *
 * A PG major upgrade versions the data-dir name (idb://app -> idb://app-pg18),
 * which abandons the old database. Without reclamation it counts against the
 * origin's storage quota indefinitely, pressuring the new DB toward eviction.
 *
 * NOTE: this runs AFTER the versioned DB has opened, so it relieves *ongoing*
 * quota pressure but cannot prevent a first-open QuotaExceededError if the orphan
 * already left the origin over quota before bootstrap (largely theoretical — open
 * + schema bootstrap writes are small; reclaiming before open would instead add
 * its enumeration/delete latency to every cold start).
 *
 * Reclaims BOTH the IndexedDB databases and the OPFS directories of every OLDER
 * same-base variant (the unversioned base + any `-pg<N>` with N < the current
 * major), by enumerating storage when the browser supports it (falling back to
 * the unversioned base name otherwise). It deliberately leaves the in-use name
 * AND any newer-major store untouched, so an older build re-run after a newer
 * one never destroys data a later re-upgrade could reopen. Covers OPFS, which the
 * IndexedDB-only factory-reset fallback list does not reach. Fire-and-forget:
 * deleting absent storage is a no-op and any failure is swallowed so reclamation
 * can't break startup.
 */
export async function reclaimLegacyBrowserPGliteStorage(versionedDataDir: string): Promise<void> {
  if (!isBrowserPersistentPGliteDataDir(versionedDataDir)) {
    return;
  }
  const suffix = `-${PGLITE_DATA_DIR_VERSION}`;
  const currentName = versionedDataDir.replace(/^(idb|opfs-ahp):\/\//, '');
  if (!currentName.endsWith(suffix)) {
    return;
  }
  const baseName = currentName.slice(0, -suffix.length);
  if (baseName.length === 0) {
    return;
  }

  try {
    const names = await legacyIndexedDbNamesToReclaim(baseName, PGLITE_ENGINE_MAJOR);
    for (const name of names) {
      indexedDB.deleteDatabase(name);
    }
  } catch {
    // best-effort only
  }

  try {
    await reclaimLegacyOpfsDirs(baseName, PGLITE_ENGINE_MAJOR);
  } catch {
    // best-effort only (entries may be absent, or a handle is still held elsewhere)
  }
}

export function isIndexedDbPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return typeof dataDir === 'string' && dataDir.startsWith('idb://');
}

export function isOpfsAhpPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return typeof dataDir === 'string' && dataDir.startsWith('opfs-ahp://');
}

export function isBrowserPersistentPGliteDataDir(dataDir: string | undefined): dataDir is string {
  return isIndexedDbPGliteDataDir(dataDir) || isOpfsAhpPGliteDataDir(dataDir);
}

export function getBrowserPGliteStorageSupport(): Required<
  Pick<BrowserPGliteStorageSupport, 'hasOpfsDirectory' | 'hasWorker'>
> {
  return {
    hasOpfsDirectory:
      typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    hasWorker: typeof Worker !== 'undefined',
  };
}

export function getRecommendedBrowserPGliteStorage(
  support: BrowserPGliteStorageSupport = getBrowserPGliteStorageSupport()
): BrowserPGliteStorageSelection {
  const hasOpfsAhpSupport = support.hasWorker === true && support.hasOpfsDirectory === true;
  if (support.requestedStorage === 'opfs-ahp') {
    if (hasOpfsAhpSupport) {
      return {
        dataDir: getOpfsAhpBrowserPGliteDataDir(),
        reason: 'requested-opfs-ahp-supported',
        storage: 'opfs-ahp',
      };
    }
    return {
      dataDir: getDefaultBrowserPGliteDataDir(),
      reason: 'requested-opfs-ahp-unavailable',
      storage: 'idb',
    };
  }

  return {
    dataDir: getDefaultBrowserPGliteDataDir(),
    reason:
      support.requestedStorage === 'idb' ? 'requested-indexeddb' : 'pglite-recommends-indexeddb',
    storage: 'idb',
  };
}
