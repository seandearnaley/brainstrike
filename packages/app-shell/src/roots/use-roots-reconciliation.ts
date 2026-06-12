import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter } from '@brainstrike/types';
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
   * Resolves to the DB root id (from the `roots` table) for the given root
   * directory path once reconciliation has settled. Returns `null` if the path
   * is not mapped (logs a warning once per path). ALWAYS settles — never hangs,
   * even if reconciliation encountered an error (empty map → null for all paths).
   */
  resolveDbRootId: (rootPath: string) => Promise<string | null>;
}

/**
 * Runs once per app boot (ref guard) to ensure a DB roots row exists for every
 * adapter root that has a persistent backing store entry. No-ops unless
 * adapter.restoreRoots exists and the db handle is ready. Errors are logged at
 * error level and swallowed — reconciliation must never block boot.
 *
 * Returns a ref-stable `resolveDbRootId` callback that awaits reconciliation
 * and maps a root directory path to its DB root id (`null` if unmapped).
 */
export function useRootsReconciliation({
  adapter,
  db,
}: UseRootsReconciliationArgs): UseRootsReconciliationResult {
  const hasRunRef = useRef(false);

  // The settling promise resolves with the path→dbRootId map on success, or an
  // empty map on the already-logged error path — it NEVER rejects or hangs.
  // Lazily initialized so renders after the first don't allocate a throwaway
  // promise; the `resolve` function is called exactly once to settle it.
  const settlingRef = useRef<SettlingMapPromise | null>(null);
  if (settlingRef.current === null) {
    settlingRef.current = createSettlingMapPromise();
  }

  // True when the boot promise was settled empty because the adapter had no
  // restoreRoots. If a later adapter identity DOES have it, the effect re-runs
  // and must re-key the settling promise — promises settle once, so reusing the
  // already-empty one would silently drop the real mapping.
  const settledWithoutRestoreRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    let settling = settlingRef.current;
    if (settling === null) {
      // Unreachable (the render phase always initializes the ref); recreate
      // rather than return so the "always settles" contract can't be broken.
      settling = createSettlingMapPromise();
      settlingRef.current = settling;
    }
    if (!adapter.restoreRoots) {
      // Reconciliation can never run on this adapter — settle with an empty
      // map so resolveDbRootId waiters don't hang (adapters without
      // restoreRoots also have no sync consumers needing real ids).
      settledWithoutRestoreRef.current = true;
      settling.resolve(new Map());
      return;
    }
    if (settledWithoutRestoreRef.current) {
      // A previous restoreRoots-less adapter settled the boot promise empty.
      // Start a fresh settling promise for this capable adapter so its real
      // mapping is not discarded; resolveDbRootId reads the ref at call time,
      // so new waiters pick up the fresh promise.
      settling = createSettlingMapPromise();
      settlingRef.current = settling;
      settledWithoutRestoreRef.current = false;
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
    const { resolve } = settling;

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
        resolve(pathMap);
      })
      .catch((err: unknown) => {
        logger.error('Root reconciliation failed', { error: err });
        // Resolve with an empty map so waiters never hang.
        resolve(new Map());
      });
  }, [adapter, db]);

  const resolveDbRootId = useCallback(
    async (rootPath: string): Promise<string | null> => {
      // Read the ref at call time: the effect may have re-keyed the settling
      // promise when a restoreRoots-capable adapter replaced an incapable one.
      const settling = settlingRef.current;
      if (settling === null) {
        // Unreachable: the render phase initializes the ref before any
        // consumer can obtain this callback. Throwing keeps the "always
        // settles" contract honest instead of hanging on a fresh promise.
        throw new Error('resolveDbRootId called before settling promise initialization');
      }
      const map = await settling.promise;
      const dbRootId = map.get(rootPath) ?? null;
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

  return { resolveDbRootId };
}
