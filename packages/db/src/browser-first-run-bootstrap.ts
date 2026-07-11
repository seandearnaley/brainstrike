import { createLogger } from '@brainstrike/utils';
import { IDB_DB_NAME_PREFIX, isIndexedDbPGliteDataDir } from './browser-pglite-storage.js';

const logger = createLogger('BrowserFirstRunBootstrap');

/**
 * FIRST-RUN FAST BOOTSTRAP (browser `idb://` stores)
 *
 * A genuine first run of the web app used to pay ~53s of PGlite bootstrap:
 * initdb + every migration executed against the IndexedDB-backed store with
 * `relaxedDurability: false`, which awaits a full Emscripten IDBFS
 * `syncfs(false)` round after EVERY statement (the #1111 durability guarantee).
 *
 * This module removes that cost for the one case where strict per-statement
 * durability buys nothing — a store that does not exist yet, holding no user
 * data — WITHOUT ever relaxing durability on the persistent store:
 *
 *   1. initdb + all migrations run in a throwaway `memory://` PGlite
 *      (no persistence at all).
 *   2. `dumpDataDir('none')` captures the fully-migrated data dir as a tarball.
 *   3. A short-lived STRICT (`relaxedDurability: false`) PGlite opens the real
 *      `idb://` store with `loadDataDir: <tarball>`, then one explicit awaited
 *      `syncToFs()` flushes the entire data dir to IndexedDB in one pass.
 *   4. Only after that flush resolves (and the store's presence is re-probed)
 *      is the bootstrap reported complete; the normal strict worker client
 *      then opens the now-existing store exactly as before.
 *
 * In production the whole pipeline runs inside a DEDICATED plain worker
 * (browser-first-run-bootstrap-worker-entry.ts via wasm-loader's
 * `runFirstRunBootstrapInWorker`), keeping the WASM work off the main thread.
 * It is deliberately NOT built on PGliteWorker sessions — see
 * browser-first-run-bootstrap-pipeline.ts for the leader-election race that
 * rules those out. This module owns only the ORCHESTRATION: probing, the
 * crash marker, cross-tab locking, and torn-store recovery.
 *
 * Why dump/load instead of the more obvious "run migrations relaxed, then
 * syncToFs, then reopen strict": PGlite's PUBLIC API cannot guarantee a flush
 * on a relaxed instance — `PGlite.syncToFs()` fire-and-forgets the underlying
 * FS sync when `relaxedDurability` is true, and `close()` does not flush
 * either (verified against @electric-sql/pglite 0.5.4 src/pglite.ts). With
 * dump/load the persistent store is only ever written by STRICT instances, so
 * the #1111 guarantee holds for every byte the store ever sees.
 *
 * Crash safety: a localStorage marker brackets the bootstrap. It is written
 * before the first IndexedDB write and cleared only after the strict flush
 * completes. A crash mid-bootstrap leaves the marker behind; the next launch
 * detects marker+store, deletes the partial store (no user data can exist in
 * it — the marker proves bootstrap never completed), and re-runs the fast
 * bootstrap greenfield. This is loud (warn-logged), never a silent fallback.
 *
 * The fast path is CAPABILITY-GATED, never silently degraded: every skip
 * returns an explicit reason and the caller falls back to the pre-existing
 * strict bootstrap path (slower, equally correct).
 */

export interface FirstRunBootstrapDependencies {
  /**
   * Runs the full dump/load pipeline for `dataDir` and resolves only once the
   * migrated store is durably flushed to IndexedDB (production:
   * wasm-loader's `runFirstRunBootstrapInWorker`; tests: the pipeline over
   * direct PGlite instances).
   */
  readonly bootstrapStore: (dataDir: string) => Promise<void>;
  /** Deletes the (partial) IndexedDB store for `dataDir`. */
  readonly deleteStore: (dataDir: string) => Promise<void>;
}

export type FirstRunBootstrapSkipReason =
  | 'not-indexeddb-data-dir'
  | 'not-browser'
  | 'indexeddb-unavailable'
  | 'web-locks-unavailable'
  | 'marker-storage-unavailable'
  | 'existing-store';

export type FirstRunBootstrapResult =
  | { readonly performed: false; readonly reason: FirstRunBootstrapSkipReason }
  | { readonly performed: true; readonly recoveredPartialBootstrap: boolean };

const FIRST_RUN_BOOTSTRAP_MARKER_KEY_PREFIX = 'brainstrike.pgliteFirstRunBootstrap:';
const FIRST_RUN_BOOTSTRAP_LOCK_PREFIX = 'brainstrike-pglite-first-run:';

export function firstRunBootstrapMarkerKey(dataDir: string): string {
  return `${FIRST_RUN_BOOTSTRAP_MARKER_KEY_PREFIX}${dataDir}`;
}

function bareIdbName(dataDir: string): string {
  return dataDir.slice('idb://'.length);
}

/**
 * The real IndexedDB database name for an `idb://` data dir — PGlite's idb
 * backend (Emscripten IDBFS) stores under `/pglite/<name>`, never the bare
 * name (see IDB_DB_NAME_PREFIX).
 */
export function firstRunBootstrapIdbDatabaseName(dataDir: string): string {
  return `${IDB_DB_NAME_PREFIX}${bareIdbName(dataDir)}`;
}

/**
 * Whether an IndexedDB database with this exact name exists, without creating
 * it. Prefers `indexedDB.databases()` enumeration; on engines without it
 * (older Safari/Firefox) falls back to an open probe whose `upgradeneeded`
 * transaction is aborted so a missing database is never materialized.
 */
export async function browserIndexedDbDatabaseExists(idbName: string): Promise<boolean> {
  if (typeof indexedDB.databases === 'function') {
    const infos = await indexedDB.databases();
    return infos.some((info) => info.name === idbName);
  }
  return await new Promise<boolean>((resolve, reject) => {
    let existed = true;
    const request = indexedDB.open(idbName);
    request.onupgradeneeded = (event) => {
      // Fires only when the database did not exist; aborting the versionchange
      // transaction cancels creation and fails the open request.
      existed = false;
      (event.target as IDBOpenDBRequest).transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(true);
    };
    request.onerror = () => {
      if (existed) {
        reject(request.error ?? new Error(`IndexedDB existence probe failed for ${idbName}`));
        return;
      }
      resolve(false);
    };
  });
}

function getMarkerStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return null;
    }
    // Privacy modes can expose localStorage but throw on use; probe it.
    const probeKey = `${FIRST_RUN_BOOTSTRAP_MARKER_KEY_PREFIX}__probe__`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

interface WebLocks {
  request(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<void>
  ): Promise<void>;
}

function getWebLocks(): WebLocks | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const locks = (navigator as Navigator & { locks?: WebLocks }).locks;
  return typeof locks?.request === 'function' ? locks : null;
}

async function recoverPartialBootstrapStore(
  dataDir: string,
  idbName: string,
  markerValue: string,
  deps: FirstRunBootstrapDependencies
): Promise<void> {
  logger.warn(
    'Detected an incomplete first-run PGlite bootstrap; deleting the partial store and re-running greenfield',
    { dataDir, markerWrittenAt: markerValue }
  );
  await deps.deleteStore(dataDir);
  if (await browserIndexedDbDatabaseExists(idbName)) {
    throw new Error(
      `Cannot reclaim the partial first-run PGlite store ${idbName}: deletion did not complete ` +
        '(another tab may be holding it open). Close other tabs and reload.'
    );
  }
}

async function performFirstRunBootstrap(
  dataDir: string,
  idbName: string,
  storage: Storage,
  deps: FirstRunBootstrapDependencies
): Promise<void> {
  storage.setItem(firstRunBootstrapMarkerKey(dataDir), new Date().toISOString());

  const startedAt = Date.now();
  await deps.bootstrapStore(dataDir);

  if (!(await browserIndexedDbDatabaseExists(idbName))) {
    throw new Error(
      `First-run PGlite bootstrap flushed successfully but the IndexedDB store ${idbName} is absent`
    );
  }

  storage.removeItem(firstRunBootstrapMarkerKey(dataDir));
  logger.info('First-run PGlite fast bootstrap completed', {
    dataDir,
    durationMs: Date.now() - startedAt,
  });
}

/**
 * Runs the first-run fast bootstrap for a browser `idb://` store when — and
 * only when — the store does not exist yet. Serialized across tabs via a Web
 * Lock; a concurrent tab waits, re-probes, and skips once the store exists.
 *
 * Errors are NOT swallowed: a failed bootstrap rejects and must surface in the
 * caller's initialization error state (the marker stays set, so the next
 * launch reclaims the partial store and retries greenfield).
 */
export async function maybeBootstrapBrowserFirstRunStore(
  dataDir: string,
  deps: FirstRunBootstrapDependencies
): Promise<FirstRunBootstrapResult> {
  if (!isIndexedDbPGliteDataDir(dataDir)) {
    return { performed: false, reason: 'not-indexeddb-data-dir' };
  }
  if (typeof window === 'undefined') {
    return { performed: false, reason: 'not-browser' };
  }
  if (typeof indexedDB === 'undefined') {
    logger.info('Skipping first-run fast bootstrap: IndexedDB unavailable', { dataDir });
    return { performed: false, reason: 'indexeddb-unavailable' };
  }
  const locks = getWebLocks();
  if (!locks) {
    logger.info('Skipping first-run fast bootstrap: Web Locks unavailable', { dataDir });
    return { performed: false, reason: 'web-locks-unavailable' };
  }
  const storage = getMarkerStorage();
  if (!storage) {
    // Without a marker a crashed bootstrap would be indistinguishable from a
    // healthy existing store — refuse the fast path rather than risk opening a
    // torn store as if it were real data.
    logger.info('Skipping first-run fast bootstrap: marker storage unavailable', { dataDir });
    return { performed: false, reason: 'marker-storage-unavailable' };
  }

  const idbName = firstRunBootstrapIdbDatabaseName(dataDir);
  let result: FirstRunBootstrapResult | null = null;

  await locks.request(
    `${FIRST_RUN_BOOTSTRAP_LOCK_PREFIX}${dataDir}`,
    { mode: 'exclusive' },
    async () => {
      // Re-probe INSIDE the lock: another tab may have just bootstrapped.
      const exists = await browserIndexedDbDatabaseExists(idbName);
      const markerValue = storage.getItem(firstRunBootstrapMarkerKey(dataDir));

      if (exists && markerValue === null) {
        result = { performed: false, reason: 'existing-store' };
        return;
      }

      let recoveredPartialBootstrap = false;
      if (exists && markerValue !== null) {
        await recoverPartialBootstrapStore(dataDir, idbName, markerValue, deps);
        recoveredPartialBootstrap = true;
      }

      await performFirstRunBootstrap(dataDir, idbName, storage, deps);
      result = { performed: true, recoveredPartialBootstrap };
    }
  );

  if (result === null) {
    throw new Error('First-run bootstrap lock callback did not produce a result');
  }
  return result;
}
