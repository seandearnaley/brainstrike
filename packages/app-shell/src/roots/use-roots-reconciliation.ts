import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reconcileRoots } from './root-registry';

const logger = createLogger('useRootsReconciliation');

// Module-level set of root identities already warned about, so each unmapped
// root only logs once across the lifetime of the app (not per-call).
const warnedUnmappedRoots = new Set<string>();

type DbRootIdMap = Map<string, string>;

interface SettlingMapPromise {
  promise: Promise<DbRootIdMap>;
  resolve: (map: DbRootIdMap) => void;
}

function createSettlingMapPromise(): SettlingMapPromise {
  let resolve!: (map: DbRootIdMap) => void;
  const promise = new Promise<DbRootIdMap>((res) => {
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
   * Reactive snapshot of the adapter-rootId → DB-rootId mapping for the
   * currently-reconciled roots (canonical adapter-id keys ONLY — no path
   * fallback keys). Unlike the ref-backed `resolveDbRootId` callback this is a
   * new Map identity each time the mapping grows, so consumers that need to
   * INVERT it (DB id → adapter id, e.g. quick-open) re-render when it resolves.
   * Empty until the boot reconcile settles.
   */
  dbRootIdByAdapterRootId: ReadonlyMap<string, string>;
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
   * Resolves to the DB root id (from the `roots` table) for the given adapter
   * root id once reconciliation has settled. `rootPath` is retained only as a
   * legacy fallback for unstamped handles. Returns `null` if the root is not
   * mapped (logs a warning once per identity). ALWAYS settles — never hangs.
   */
  resolveDbRootId: (rootPath: string, adapterRootId?: string | null) => Promise<string | null>;
}

interface PerformRootRegistrationArgs {
  adapter: FileSystemAdapter;
  db: DbHandle | null;
  dbRootIdMap: DbRootIdMap;
  descriptor: RootDescriptor;
  /** Publishes the canonical adapter-rootId → DB-rootId pair to reactive state. */
  publishCanonicalMapping: (adapterRootId: string, dbRootId: string) => void;
}

/**
 * The body of a single mid-session registration, run AFTER the boot settle.
 * Mutates `dbRootIdMap` (the hook's growable ref target) on success. Never throws.
 */
async function performRootRegistration({
  adapter,
  db,
  descriptor,
  dbRootIdMap,
  publishCanonicalMapping,
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
  if (dbRootIdMap.has(descriptor.rootId)) {
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
      dbRootIdMap.set(descriptor.rootId, dbRootId);
      dbRootIdMap.set(descriptor.handle.path, dbRootId);
      publishCanonicalMapping(descriptor.rootId, dbRootId);
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
 *   registrations already enqueued) and maps adapter root id to its DB root id
 *   (`rootPath` is only the legacy fallback when no adapter id is available).
 * - `registerRoot` registers a root added mid-session so its DB row exists at
 *   add time instead of at next boot.
 */
export function useRootsReconciliation({
  adapter,
  db,
}: UseRootsReconciliationArgs): UseRootsReconciliationResult {
  const hasRunRef = useRef(false);

  // Reactive snapshot of the canonical adapter-rootId → DB-rootId mapping
  // (adapter-id keys only — never the path fallback keys held in
  // dbRootIdMapRef). Exposed so consumers that invert it (DB id → adapter id)
  // re-render when reconciliation settles or a mid-session root registers.
  const [dbRootIdByAdapterRootId, setDbRootIdByAdapterRootId] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());

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
  // already-empty one would leave the real mapping only eventually visible via
  // dbRootIdMapRef instead of deterministically awaited.
  const settledWithoutRestoreRef = useRef(false);

  // The growable adapterRootId→dbRootId map. Seeded by the boot reconcile result
  // and extended by registerRoot, so later imports see mid-session roots
  // immediately. Legacy path keys are written only as a fallback for unstamped
  // handles; canonical callers pass adapter rootId.
  const dbRootIdMapRef = useRef<DbRootIdMap>(new Map());

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

  // Merges a canonical adapter→db pair into the reactive snapshot. No-ops when
  // the pair is already present so a re-resolved boot map never churns the Map
  // identity (and therefore never re-renders inverting consumers needlessly).
  // Declared before the boot effect that calls it (avoids a TDZ in the effect's
  // dep array).
  const publishCanonicalMapping = useCallback((adapterRootId: string, dbRootId: string): void => {
    setDbRootIdByAdapterRootId((prev) => {
      if (prev.get(adapterRootId) === dbRootId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(adapterRootId, dbRootId);
      return next;
    });
  }, []);

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
      // hasRunRef is deliberately NOT set here: if the adapter is later
      // replaced by one WITH restoreRoots, the boot reconcile still runs and
      // seeds dbRootIdMapRef.
      settledWithoutRestoreRef.current = true;
      settling.resolve(new Map());
      return;
    }
    if (settledWithoutRestoreRef.current) {
      // A previous restoreRoots-less adapter settled the boot promise empty.
      // Start a fresh settling promise for this capable adapter so waiters
      // deterministically await its real mapping (dbRootIdMapRef read-through
      // would only make it eventually visible); resolveDbRootId reads the
      // ref at call time, so new waiters pick up the fresh promise.
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
        // Build adapterRootId → dbRootId map from the descriptors + registry result.
        // Descriptors the registry skipped (not in the mapping) are simply absent.
        const dbRootIdMap: DbRootIdMap = new Map();
        for (const descriptor of adapterRoots) {
          const dbRootId = result.dbRootIdByAdapterRootId.get(descriptor.rootId);
          if (dbRootId !== undefined) {
            dbRootIdMap.set(descriptor.rootId, dbRootId);
            dbRootIdMap.set(descriptor.handle.path, dbRootId);
          }
        }
        // Seed the growable ref BEFORE settling, so consumers awaiting the
        // settle observe the boot mappings the instant the promise resolves.
        for (const [rootKey, dbRootId] of dbRootIdMap) {
          dbRootIdMapRef.current.set(rootKey, dbRootId);
        }
        // Publish ONLY the canonical adapter-id keys to reactive state (the
        // descriptor.rootId entries — never the path fallback keys).
        for (const descriptor of adapterRoots) {
          const dbRootId = dbRootIdMap.get(descriptor.rootId);
          if (dbRootId !== undefined) {
            publishCanonicalMapping(descriptor.rootId, dbRootId);
          }
        }
        resolve(dbRootIdMap);
      })
      .catch((err: unknown) => {
        logger.error('Root reconciliation failed', { error: err });
        // Resolve with an empty map so waiters never hang.
        resolve(new Map());
      });
  }, [adapter, db, publishCanonicalMapping]);

  // Reads the settling ref at call time (the effect may have re-keyed it when
  // a restoreRoots-capable adapter replaced an incapable one). The null case
  // is unreachable — the render phase initializes the ref before any consumer
  // can obtain these callbacks — and throwing keeps the "always settles"
  // contract honest instead of hanging on a fresh promise.
  const awaitBootSettle = useCallback(async (): Promise<void> => {
    const settling = settlingRef.current;
    if (settling === null) {
      throw new Error('roots reconciliation awaited before settling promise initialization');
    }
    await settling.promise;
  }, []);

  const registerRoot = useCallback(
    async (descriptor: RootDescriptor): Promise<void> => {
      const run = async (): Promise<void> => {
        // Ordering: the boot reconcile wins races — never write before it settles.
        await awaitBootSettle();
        await performRootRegistration({
          adapter: adapterRef.current,
          db: dbRef.current,
          dbRootIdMap: dbRootIdMapRef.current,
          descriptor,
          publishCanonicalMapping,
        });
      };
      // Serialize registrations so two adds for the same path cannot interleave
      // their SELECT/INSERT and double-insert. performRootRegistration never
      // rejects, so the chain cannot break.
      const chained = pendingRegistrationsRef.current.then(run);
      pendingRegistrationsRef.current = chained;
      return await chained;
    },
    [awaitBootSettle, publishCanonicalMapping]
  );

  const resolveDbRootId = useCallback(
    async (rootPath: string, adapterRootId?: string | null): Promise<string | null> => {
      await awaitBootSettle();
      // Mid-session registrations enqueued before this call must be visible:
      // a sync pass triggered by the same Add Folder commit would otherwise
      // race the INSERT and write root_id = NULL. The chain only grows
      // synchronously inside registerRoot, so awaiting the tail is sufficient.
      await pendingRegistrationsRef.current;
      const rootKey = adapterRootId || rootPath;
      const dbRootId = dbRootIdMapRef.current.get(rootKey) ?? null;
      if (dbRootId === null && !warnedUnmappedRoots.has(rootKey)) {
        warnedUnmappedRoots.add(rootKey);
        logger.warn('Root identity has no mapped db root id', { adapterRootId, rootPath });
      }
      return dbRootId;
    },
    [awaitBootSettle]
  );

  return { dbRootIdByAdapterRootId, registerRoot, resolveDbRootId };
}
