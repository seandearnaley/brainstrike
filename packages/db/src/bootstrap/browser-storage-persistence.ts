import { createLogger } from '@brainstrike/utils';

const logger = createLogger('DB:BrowserStoragePersistence');

/**
 * Outcome of the boot-time persistent-storage request for the browser Turso
 * OPFS store family.
 */
export interface BrowserPersistentStorageRequestOutcome {
  readonly granted: boolean;
  readonly supported: boolean;
}

/**
 * Narrow injectable seam over `navigator.storage`: the request only needs
 * `persist()`, and scripted test doubles must not have to fake the whole
 * StorageManager surface.
 */
export type BrowserPersistentStorageManager = Pick<StorageManager, 'persist'>;

function defaultStorageManager(): BrowserPersistentStorageManager | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
    return;
  }
  return navigator.storage;
}

/**
 * A7 cutover follow-up (ledger: "Browser OPFS Durability And Storage
 * Pressure (2026-07-05)"): now that Turso WASM is the browser default,
 * request `navigator.storage.persist()` once at browser-Turso boot so
 * Chromium exempts the origin bucket (and with it the OPFS db file family)
 * from LRU eviction under disk pressure.
 *
 * This is a best-effort UPGRADE, never a gate: the boolean outcome is logged
 * (Chromium grants silently for engaged/installed origins and denies
 * otherwise — some browsers may prompt), and a denial or an unsupported/
 * failing StorageManager leaves the pre-cutover best-effort eviction posture
 * unchanged. It must therefore never block or fail the Turso bootstrap —
 * this function always resolves.
 */
export async function requestBrowserTursoPersistentStorage(
  storage: BrowserPersistentStorageManager | undefined = defaultStorageManager()
): Promise<BrowserPersistentStorageRequestOutcome> {
  if (!storage || typeof storage.persist !== 'function') {
    logger.warn(
      'Persistent-storage request skipped: navigator.storage.persist is unavailable in this browser. ' +
        'Browser Turso OPFS data stays under best-effort (evictable) storage.'
    );
    return { granted: false, supported: false };
  }

  try {
    const granted = await storage.persist();
    logger.info(
      `Persistent-storage request for the browser Turso OPFS store resolved (granted: ${granted}).` +
        (granted
          ? ' The origin storage bucket is exempt from automatic eviction.'
          : ' The origin stays under best-effort storage; Chromium may evict the whole bucket under disk pressure.')
    );
    return { granted, supported: true };
  } catch (error) {
    logger.error(
      'Persistent-storage request for the browser Turso OPFS store failed; continuing under best-effort storage.',
      { error }
    );
    return { granted: false, supported: true };
  }
}
