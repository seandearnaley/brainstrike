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
 * Bump this whenever the bundled PGlite ships a new Postgres major.
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
 * Best-effort reclamation of the legacy (pre-engine-version) browser storage for
 * the SAME database base name, run once after the versioned database opens.
 *
 * A PG major upgrade versions the data-dir name (idb://app -> idb://app-pg18),
 * which abandons the old unversioned database. Without reclamation it counts
 * against the origin's storage quota indefinitely — and on a near-full quota the
 * orphan can even make the fresh versioned DB hit QuotaExceededError.
 *
 * Deletes both the legacy IndexedDB database and the legacy OPFS directory of the
 * same base name (covers whichever backend the user had before, including OPFS,
 * which the IndexedDB-only factory-reset fallback list does not reach). It never
 * touches the in-use versioned name. Fire-and-forget: deleting absent storage is a
 * harmless no-op and any failure is swallowed so reclamation can't break startup.
 */
export async function reclaimLegacyBrowserPGliteStorage(versionedDataDir: string): Promise<void> {
  const suffix = `-${PGLITE_DATA_DIR_VERSION}`;
  if (!isBrowserPersistentPGliteDataDir(versionedDataDir)) {
    return;
  }
  const withoutScheme = versionedDataDir.replace(/^(idb|opfs-ahp):\/\//, '');
  if (!withoutScheme.endsWith(suffix)) {
    return;
  }
  const legacyName = withoutScheme.slice(0, -suffix.length);
  if (legacyName.length === 0) {
    return;
  }

  // Legacy IndexedDB database (the pre-version base name).
  try {
    if (typeof indexedDB !== 'undefined') {
      indexedDB.deleteDatabase(legacyName);
    }
  } catch {
    // best-effort only
  }

  // Legacy OPFS directory of the same base name (unversioned).
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(legacyName, { recursive: true });
    }
  } catch {
    // best-effort only (entry may be absent, or the OPFS layout differs)
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
