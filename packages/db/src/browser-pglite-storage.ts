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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names to reclaim for a base: the unversioned base and ANY engine-versioned
 * variant of it (`app`, `app-pg17`, `app-pg18`, …), excluding the in-use name.
 * Matching every prior major — not just the immediately-previous suffix — keeps
 * reclamation correct across repeated major bumps (pg18 -> pg19 -> …).
 */
function isReclaimableLegacyName(name: string, baseName: string, currentName: string): boolean {
  if (name === currentName) {
    return false;
  }
  return new RegExp(`^${escapeRegExp(baseName)}(-pg\\d+)?$`).test(name);
}

async function legacyIndexedDbNamesToReclaim(
  baseName: string,
  currentName: string
): Promise<string[]> {
  if (typeof indexedDB === 'undefined') {
    return [];
  }
  // Enumerate when supported so every prior-major orphan is reclaimed, not just
  // the one whose suffix we can derive from the current name.
  if (typeof indexedDB.databases === 'function') {
    const infos = await indexedDB.databases();
    return infos
      .map((info) => info.name)
      .filter((name): name is string => typeof name === 'string')
      .filter((name) => isReclaimableLegacyName(name, baseName, currentName));
  }
  // Enumeration unavailable (older Safari/Firefox): best-effort delete the
  // unversioned base name. Prior versioned majors can't be discovered here; the
  // maintained factory-reset fallback list is the secondary cleanup path.
  return baseName === currentName ? [] : [baseName];
}

async function reclaimLegacyOpfsDirs(baseName: string, currentName: string): Promise<void> {
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
      if (isReclaimableLegacyName(name, baseName, currentName)) {
        names.push(name);
      }
    }
  } else if (baseName !== currentName) {
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
 * origin's storage quota indefinitely — and on a near-full quota the orphan can
 * even make the fresh versioned DB hit QuotaExceededError.
 *
 * Reclaims BOTH the IndexedDB databases and the OPFS directories of every
 * same-base variant (unversioned + all prior majors) EXCEPT the in-use name, by
 * enumerating storage when the browser supports it (falling back to the
 * unversioned base name otherwise). Covers OPFS, which the IndexedDB-only
 * factory-reset fallback list does not reach. Fire-and-forget: deleting absent
 * storage is a no-op and any failure is swallowed so reclamation can't break
 * startup.
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
    const names = await legacyIndexedDbNamesToReclaim(baseName, currentName);
    for (const name of names) {
      indexedDB.deleteDatabase(name);
    }
  } catch {
    // best-effort only
  }

  try {
    await reclaimLegacyOpfsDirs(baseName, currentName);
  } catch {
    // best-effort only (entries may be absent, or the OPFS layout differs)
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
