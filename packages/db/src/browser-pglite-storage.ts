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

export function getDefaultBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `idb://${dbName}`;
}

export function getOpfsAhpBrowserPGliteDataDir(dbName = DEFAULT_BROWSER_DB_NAME): string {
  return `opfs-ahp://${dbName}`;
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
