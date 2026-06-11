import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useRef } from 'react';
import { reconcileRoots } from './root-registry';

const logger = createLogger('useRootsReconciliation');

// Module-level set of root paths already warned about, so each unmapped path
// only logs once across the lifetime of the app (not per-call).
const warnedUnmappedPaths = new Set<string>();

type PathMap = Map<string, string>;

interface SettlingMapPromise {
  promise: Promise<PathMap>;
  resolve: (map: PathMap) => void;
}

function createSettlingMapPromise(): SettlingMapPromise {
  let resolve!: (map: PathMap) => void;
  const promise = new Promise<PathMap>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface UseRootsReconciliationArgs {
  adapter: FileSystemAdapter;
  db: DbHandle | null;
}

export interface UseRootsReconciliationResult {
  /**
   * Registers a root added mid-session (Add Folder) in the DB `roots` table
   * immediately, so its imports carry a real `root_id` without waiting for the
   * next boot's reconciliation pass. Ref-stable. Awaits the boot settle first
   * (the boot reconcile wins races), skips unregistrable descriptors
   * (persisted:false / permissionState 'unknown' — the same filter as
   * reconcileRoots) and paths that are already mapped. Errors are logged and
   * swallowed — the returned promise never rejects.
   */
  registerRoot: (descriptor: RootDescriptor) => Promise<void>;
  /**
   * Resolves to the DB root id (from the `roots` table) for the given root
   * directory path once reconciliation has settled. Returns `null` if the path
   * is not mapped (logs a warning once per path). ALWAYS settles — never hangs,
   * even if reconciliation encountered an error (empty map → null for all paths).
   */
  resolveDbRootId: (rootPath: string) => Promise<string | null>;
}

interface PerformRootRegistrationArgs {
  adapter: FileSystemAdapter;
  db: DbHandle | null;
  descriptor: RootDescriptor;
  pathMap: PathMap;
}

/**
 * The body of a single mid-session registration, run AFTER the boot settle.
 * Mutates `pathMap` (the hook's growable ref target) on success. Never throws.
 */
async function performRootRegistration({
  adapter,
  db,
  descriptor,
  pathMap,
}: PerformRootRegistrationArgs): Promise<void> {
  if (!adapter.restoreRoots) {
    // Mirrors the boot no-op: on adapters without restoreRoots the registered
    // id could never be restored next session, so a DB row would be orphaned.
    logger.debug('registerRoot skipped: adapter cannot restore roots', {
      rootId: descriptor.rootId,
    });
    return;
  }
  if (!descriptor.persisted || descriptor.permissionState === 'unknown') {
    // Same filter as reconcileRoots: session-only roots and dead handles never
    // return from restoreRoots(), so registering them would orphan DB rows.
    // Filtered here too so no query is issued at all.
    logger.warn('registerRoot skipped: unregistrable descriptor', {
      permissionState: descriptor.permissionState,
      persisted: descriptor.persisted,
      rootId: descriptor.rootId,
    });
    return;
  }
  if (pathMap.has(descriptor.handle.path)) {
    // Already mapped — the boot reconcile (or an earlier registerRoot) won.
    return;
  }
  if (!db) {
    logger.warn('registerRoot skipped: db handle unavailable', {
      rootId: descriptor.rootId,
    });
    return;
  }
  try {
    const platformKind = adapter.platform === 'electron' ? 'path' : 'fsa';
    const result = await reconcileRoots({
      adapterRoots: [descriptor],
      platformKind,
      query: db.query,
    });
    const dbRootId = result.dbRootIdByAdapterRootId.get(descriptor.rootId);
    if (dbRootId !== undefined) {
      pathMap.set(descriptor.handle.path, dbRootId);
    }
  } catch (err) {
    logger.error('Mid-session root registration failed', {
      error: err,
      rootId: descriptor.rootId,
    });
  }
}

/**
 * Runs once per app boot (ref guard) to ensure a DB roots row exists for every
 * adapter root that has a persistent backing store entry. No-ops unless
 * adapter.restoreRoots exists and the db handle is ready. Errors are logged at
 * error level and swallowed — reconciliation must never block boot.
 *
 * Returns ref-stable callbacks:
 * - `resolveDbRootId` awaits the boot reconciliation (plus any mid-session
 *   registrations already enqueued) and maps a root directory path to its DB
 *   root id (`null` if unmapped).
 * - `registerRoot` registers a root added mid-session so its DB row exists at
 *   add time instead of at next boot.
 */
export function useRootsReconciliation({
  adapter,
  db,
}: UseRootsReconciliationArgs): UseRootsReconciliationResult {
  const hasRunRef = useRef(false);

  // The settling promise resolves with the path→dbRootId map on success, or an
  // empty map on the already-logged error path — it NEVER rejects or hangs.
  // Initialized once; the `resolve` function is called exactly once to settle it.
  const settlingRef = useRef<SettlingMapPromise>(createSettlingMapPromise());

  // The growable path→dbRootId map. Seeded by the boot reconcile result and
  // extended by registerRoot, so later imports see mid-session roots
  // immediately. The settling promise above stays the boot-ordering gate.
  const pathMapRef = useRef<PathMap>(new Map());

  // Tail of the serialized mid-session registration chain. Grown synchronously
  // inside registerRoot so resolveDbRootId can await every registration that
  // was enqueued before it was called.
  const pendingRegistrationsRef = useRef<Promise<void>>(Promise.resolve());

  // Latest adapter/db for mid-session registration, read at call time so
  // registerRoot stays identity-stable without stale captures.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const dbRef = useRef(db);
  dbRef.current = db;

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    if (!adapter.restoreRoots) {
      // Reconciliation can never run on this adapter — settle with an empty
      // map so resolveDbRootId waiters don't hang (adapters without
      // restoreRoots also have no sync consumers needing real ids).
      settlingRef.current.resolve(new Map());
      return;
    }
    if (!db) {
      // Deliberately NOT settled: db is not ready YET and the effect re-runs
      // when it arrives. Settling empty here would be permanent (promises
      // resolve once), silently dropping the later real mapping. No consumer
      // can await resolveDbRootId before db exists — the sync service is
      // constructed from the same db handle, so it doesn't exist yet either.
      return;
    }
    hasRunRef.current = true;

    const platformKind = adapter.platform === 'electron' ? 'path' : 'fsa';
    const { resolve } = settlingRef.current;

    void adapter
      .restoreRoots()
      .then(async (adapterRoots) => {
        const result = await reconcileRoots({
          adapterRoots,
          platformKind,
          query: db.query,
        });
        // Build path → dbRootId map from the descriptors + the registry result.
        // Descriptors the registry skipped (not in the mapping) are simply absent.
        const pathMap: PathMap = new Map();
        for (const descriptor of adapterRoots) {
          const dbRootId = result.dbRootIdByAdapterRootId.get(descriptor.rootId);
          if (dbRootId !== undefined) {
            pathMap.set(descriptor.handle.path, dbRootId);
          }
        }
        // Seed the growable ref BEFORE settling, so consumers awaiting the
        // settle observe the boot mappings the instant the promise resolves.
        for (const [rootPath, dbRootId] of pathMap) {
          pathMapRef.current.set(rootPath, dbRootId);
        }
        resolve(pathMap);
      })
      .catch((err: unknown) => {
        logger.error('Root reconciliation failed', { error: err });
        // Resolve with an empty map so waiters never hang.
        resolve(new Map());
      });
  }, [adapter, db]);

  const registerRoot = useCallback(async (descriptor: RootDescriptor): Promise<void> => {
    const run = async (): Promise<void> => {
      // Ordering: the boot reconcile wins races — never write before it settles.
      await settlingRef.current.promise;
      await performRootRegistration({
        adapter: adapterRef.current,
        db: dbRef.current,
        descriptor,
        pathMap: pathMapRef.current,
      });
    };
    // Serialize registrations so two adds for the same path cannot interleave
    // their SELECT/INSERT and double-insert. performRootRegistration never
    // rejects, so the chain cannot break.
    const chained = pendingRegistrationsRef.current.then(run);
    pendingRegistrationsRef.current = chained;
    return await chained;
    // Intentionally empty — the callback must be identity-stable so the
    // provider's registration effect does not loop on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveDbRootId = useCallback(
    async (rootPath: string): Promise<string | null> => {
      await settlingRef.current.promise;
      // Mid-session registrations enqueued before this call must be visible:
      // a sync pass triggered by the same Add Folder commit would otherwise
      // race the INSERT and write root_id = NULL. The chain only grows
      // synchronously inside registerRoot, so awaiting the tail is sufficient.
      await pendingRegistrationsRef.current;
      const dbRootId = pathMapRef.current.get(rootPath) ?? null;
      if (dbRootId === null && !warnedUnmappedPaths.has(rootPath)) {
        warnedUnmappedPaths.add(rootPath);
        logger.warn('Root path has no mapped db root id', { rootPath });
      }
      return dbRootId;
    },
    // Intentionally empty — the callback must be identity-stable so the service
    // useMemo is not reconstructed when the mapping resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { registerRoot, resolveDbRootId };
}
