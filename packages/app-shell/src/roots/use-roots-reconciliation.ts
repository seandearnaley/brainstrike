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
  // Initialized once; the `resolve` function is called exactly once to settle it.
  const settlingRef = useRef<SettlingMapPromise>(createSettlingMapPromise());

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    if (!(adapter.restoreRoots && db)) {
      // Adapter does not support restoreRoots or db is not ready: resolve with
      // an empty map now so resolveDbRootId callers never hang. The promise
      // ignores subsequent resolve() calls, so this is safe if the effect
      // re-runs before the adapter/db becomes ready.
      settlingRef.current.resolve(new Map());
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
      const map = await settlingRef.current.promise;
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
