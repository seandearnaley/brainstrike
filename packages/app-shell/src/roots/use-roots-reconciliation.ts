import type { DbHandle } from '@brainstrike/db/react';
import type { IndexRootRegistrationCapability } from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ChangesBridge, resolveChangesBridge } from '../changes/changes-bridge';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import { notifyRootRegistered } from './root-registration-events';
import { mapHostRecordedRoots, reconcileRoots } from './root-registry';

/**
 * Desktop Main's root registry owns folder records (BST-1990), so reconciliation
 * only maps onto them there; elsewhere (web) it writes them.
 */
function reconcilerFor(adapter: FileSystemAdapter): typeof reconcileRoots {
  return adapter.ownsRootRecords ? mapHostRecordedRoots : reconcileRoots;
}

const logger = createLogger('useRootsReconciliation');

/**
 * Best-effort git-inventory DISCOVERY nudge (BST-1397).
 *
 * The main-process git inventory arms its per-repository git-metadata watchers
 * only inside an inventory BUILD, and a build only runs from `getSnapshot()`
 * — the eager call at app-ready plus renderer `changes:inventory` IPC calls.
 * `loadRoots()` reads the DB `roots` table, so a root whose row appears AFTER
 * app-ready (mid-session Add Folder / Recents / `addRootByPath`, or a fresh
 * install whose renderer reconciliation inserts rows after main's eager build)
 * is never discovered: no watcher, no `changes:invalidated` push, and the
 * composer's Branch chip stays stale until something else calls `inventory()`.
 * Root registration is the exact moment a root becomes discoverable, so it is
 * where the one nudge belongs. NOT polling — one call per registration event.
 *
 * Deliberately best-effort: the Changes surface's own `inventory()` remains the
 * authoritative consumer, so a failure here is a WARN, never a thrown boot
 * error. Both failure shapes are reported — a rejected call AND an `ok: false`
 * `GitResult` — so a refused refresh is never silently dropped.
 *
 * `bridge === null` is web (or a malformed bridge, already logged by the
 * resolver): there is no desktop inventory to arm, so this is a real no-op and
 * never a stub.
 */
function refreshGitInventoryAfterRootRegistration(bridge: ChangesBridge | null): void {
  if (bridge === null) {
    return;
  }
  void bridge
    // FORCED (`maxAgeMs: 0`): the ordinary read would serve the TTL cache, or
    // coalesce onto a build whose `loadRoots()` already ran — either way a
    // snapshot that predates the row just written, and the nudge would be
    // swallowed with nothing to show for it.
    .inventory({ maxAgeMs: 0 })
    .then((result) => {
      if (!result.ok) {
        logger.warn('git inventory refresh after root registration failed', {
          error: result.error,
        });
      }
    })
    .catch((error: unknown) => {
      logger.warn('git inventory refresh after root registration failed', { error });
    });
}

/** The committed roots writer notifies Main; the renderer never supplies authority. */
function refreshNativeIndexAfterRootRegistration(): void {
  const bridge = (window as Window & { indexSearch?: Partial<IndexRootRegistrationCapability> })
    .indexSearch;
  if (!bridge) {
    return;
  }
  if (typeof bridge.rootsRegistered !== 'function') {
    logger.error('Native root registration capability is unavailable');
    return;
  }
  // Main retains and joins reconfiguration. Folder selection waits only for its
  // canonical write, while the index status owns ingestion progress and failure.
  void bridge.rootsRegistered().catch((error: unknown) => {
    logger.error('Native index refresh after root registration failed', { error });
  });
}

// Module-level set of root identities already warned about, so each unmapped
// root only logs once across the lifetime of the app (not per-call).
const warnedUnmappedRoots = new Set<string>();

type DbRootIdMap = Map<string, string>;

async function refreshManagedWorktreePaths(
  bridge: ReturnType<typeof resolveWorktreesBridge>,
  knownRef: RefObject<boolean>,
  managedWorktreeCapabilityRequired: boolean,
  pathsRef: RefObject<ReadonlySet<string>>
): Promise<void> {
  if (!bridge) {
    if (!managedWorktreeCapabilityRequired) {
      // Web has no managed-worktree capability, so the empty set is
      // authoritative. A missing/malformed desktop bridge stays unknown.
      knownRef.current = true;
    }
    return;
  }
  try {
    const listed = await bridge.listManagedPaths();
    if (listed.ok) {
      pathsRef.current = new Set(listed.value.map((entry) => entry.path));
      knownRef.current = true;
      return;
    }
    logger.warn('could not list managed worktrees; keeping the previous set', {
      error: listed.error,
    });
  } catch (error) {
    logger.warn('could not list managed worktrees; keeping the previous set', { error });
  }
}

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

/** The same map when every key is still mounted, so consumers don't re-render. */
function retainMountedKeys(
  map: ReadonlyMap<string, string>,
  mounted: ReadonlySet<string>
): ReadonlyMap<string, string> {
  const kept = [...map].filter(([adapterRootId]) => mounted.has(adapterRootId));
  return kept.length === map.size ? map : new Map(kept);
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
   * Reactive snapshot of the adapter-rootId → persisted DB `roots.kind`
   * mapping. Empty until boot reconciliation settles, then grows alongside
   * `dbRootIdByAdapterRootId` for mid-session registrations.
   */
  dbRootKindByAdapterRootId: ReadonlyMap<string, string>;
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
  /** True once the boot reconciliation promise has settled, successfully or not. */
  rootsReconciliationSettled: boolean;
  /**
   * Registers the currently mounted folders after forgetting any that are no
   * longer mounted, so a folder re-added under its one id registers again
   * (BST-1990). Serialized with `registerRoot`; never rejects.
   */
  syncMountedRoots: (current: readonly RootDescriptor[]) => Promise<void>;
}

interface PerformRootRegistrationArgs {
  adapter: FileSystemAdapter;
  db: DbHandle | null;
  dbRootIdMap: DbRootIdMap;
  descriptor: RootDescriptor;
  managedWorktreePathsKnownRef: RefObject<boolean>;
  managedWorktreePathsRef: RefObject<ReadonlySet<string>>;
  publishCanonicalKind: (adapterRootId: string, kind: string) => void;
  /** Publishes the canonical adapter-rootId → DB-rootId pair to reactive state. */
  publishCanonicalMapping: (adapterRootId: string, dbRootId: string) => void;
  worktreesBridge: ReturnType<typeof resolveWorktreesBridge>;
}

interface ApplyBootReconciliationResultArgs {
  adapterRoots: readonly RootDescriptor[];
  dbRootIdMapRef: RefObject<DbRootIdMap>;
  publishCanonicalKind: (adapterRootId: string, kind: string) => void;
  publishCanonicalMapping: (adapterRootId: string, dbRootId: string) => void;
  result: Awaited<ReturnType<typeof reconcileRoots>>;
}

function applyBootReconciliationResult({
  adapterRoots,
  dbRootIdMapRef,
  publishCanonicalKind,
  publishCanonicalMapping,
  result,
}: ApplyBootReconciliationResultArgs): { dbRootIdMap: DbRootIdMap; insertedAny: boolean } {
  const dbRootIdMap: DbRootIdMap = new Map();
  for (const descriptor of adapterRoots) {
    const dbRootId = result.dbRootIdByAdapterRootId.get(descriptor.rootId);
    if (dbRootId === undefined) {
      continue;
    }
    dbRootIdMap.set(descriptor.rootId, dbRootId);
    dbRootIdMap.set(descriptor.handle.path, dbRootId);
  }
  for (const [rootKey, dbRootId] of dbRootIdMap) {
    dbRootIdMapRef.current.set(rootKey, dbRootId);
  }
  // Insert-vs-match (BST-1400 item 11): an ordinary boot with only
  // already-registered roots matches every one of them — the git inventory's
  // own eager app-ready build already discovered those, so re-nudging it here
  // would be one wasted extra build every single session. Only a GENUINE new
  // row (see `insertedAdapterRootIds`'s doc in root-registry.ts) needs it.
  let insertedAny = false;
  for (const descriptor of adapterRoots) {
    const dbRootId = dbRootIdMap.get(descriptor.rootId);
    if (dbRootId === undefined) {
      continue;
    }
    publishCanonicalMapping(descriptor.rootId, dbRootId);
    const kind = result.dbRootKindByAdapterRootId.get(descriptor.rootId);
    if (kind !== undefined) {
      publishCanonicalKind(descriptor.rootId, kind);
    }
    // Wakes any `awaitRootRegistration` waiter outside this component subtree
    // (e.g. `useWorkspaceBar`'s MAIN-root resolution) — see
    // `root-registration-events.ts` for why this can't be a React context read.
    // Fires for EVERY successfully-mapped root, matched or inserted — a
    // matched-and-restored-to-'live' root (the remove-then-re-add shape) is
    // just as real a registration for a waiter's purposes as a fresh insert.
    notifyRootRegistered([descriptor.rootId, descriptor.handle.path]);
    if (result.insertedAdapterRootIds.has(descriptor.rootId)) {
      insertedAny = true;
    }
  }
  return { dbRootIdMap, insertedAny };
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
  managedWorktreePathsKnownRef,
  managedWorktreePathsRef,
  publishCanonicalMapping,
  publishCanonicalKind,
  worktreesBridge,
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
    await refreshManagedWorktreePaths(
      worktreesBridge,
      managedWorktreePathsKnownRef,
      adapter.platform === 'electron',
      managedWorktreePathsRef
    );
    const result = await reconcilerFor(adapter)({
      adapterRoots: [descriptor],
      managedWorktreePaths: managedWorktreePathsRef.current,
      managedWorktreePathsKnown: managedWorktreePathsKnownRef.current,
      platformKind,
      query: db.query,
    });
    const dbRootId = result.dbRootIdByAdapterRootId.get(descriptor.rootId);
    if (dbRootId !== undefined) {
      dbRootIdMap.set(descriptor.rootId, dbRootId);
      dbRootIdMap.set(descriptor.handle.path, dbRootId);
      publishCanonicalMapping(descriptor.rootId, dbRootId);
      const kind = result.dbRootKindByAdapterRootId.get(descriptor.rootId);
      if (kind !== undefined) {
        publishCanonicalKind(descriptor.rootId, kind);
      }
      // Same wake-up as the boot batch above — this is the mid-session Add
      // Folder / Recent path `useWorkspaceBar` used to poll the database for.
      notifyRootRegistered([descriptor.rootId, descriptor.handle.path]);
      // The root is now in the `roots` table the inventory's loadRoots() reads.
      refreshGitInventoryAfterRootRegistration(resolveChangesBridge());
      refreshNativeIndexAfterRootRegistration();
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
  // Resolved ONCE per hook instance: the bridge identity is an effect input.
  const worktreesBridge = useMemo(() => resolveWorktreesBridge(), []);
  const managedWorktreePathsKnownRef = useRef(false);
  const managedWorktreePathsRef = useRef<ReadonlySet<string>>(new Set());

  // Reactive snapshot of the canonical adapter-rootId → DB-rootId mapping
  // (adapter-id keys only — never the path fallback keys held in
  // dbRootIdMapRef). Exposed so consumers that invert it (DB id → adapter id)
  // re-render when reconciliation settles or a mid-session root registers.
  const [dbRootIdByAdapterRootId, setDbRootIdByAdapterRootId] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [dbRootKindByAdapterRootId, setDbRootKindByAdapterRootId] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [rootsReconciliationSettled, setRootsReconciliationSettled] = useState(false);

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
  const publishCanonicalKind = useCallback((adapterRootId: string, kind: string): void => {
    setDbRootKindByAdapterRootId((prev) => {
      if (prev.get(adapterRootId) === kind) {
        return prev;
      }
      const next = new Map(prev);
      next.set(adapterRootId, kind);
      return next;
    });
  }, []);
  const publishReconciliationSettled = useCallback((settled: boolean): void => {
    setRootsReconciliationSettled(settled);
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
      const settlingWithoutRestore = settling;
      void Promise.resolve().then(() => {
        settlingWithoutRestore.resolve(new Map());
        publishReconciliationSettled(true);
      });
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
      publishReconciliationSettled(false);
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
        await refreshManagedWorktreePaths(
          worktreesBridge,
          managedWorktreePathsKnownRef,
          adapter.platform === 'electron',
          managedWorktreePathsRef
        );
        const result = await reconcilerFor(adapter)({
          adapterRoots,
          managedWorktreePaths: managedWorktreePathsRef.current,
          managedWorktreePathsKnown: managedWorktreePathsKnownRef.current,
          platformKind,
          query: db.query,
        });
        const { dbRootIdMap, insertedAny } = applyBootReconciliationResult({
          adapterRoots,
          dbRootIdMapRef,
          publishCanonicalKind,
          publishCanonicalMapping,
          result,
        });
        // Host restoration can write roots after Main's eager inventory build.
        // Its renderer mapping reports no inserts, but those roots still need
        // discovery (BST-1990: missing branch badges in the folders panel).
        if (insertedAny || (adapter.ownsRootRecords && dbRootIdMap.size > 0)) {
          refreshGitInventoryAfterRootRegistration(resolveChangesBridge());
        }
        if (insertedAny) {
          refreshNativeIndexAfterRootRegistration();
        }
        resolve(dbRootIdMap);
        publishReconciliationSettled(true);
      })
      .catch((err: unknown) => {
        logger.error('Root reconciliation failed', { error: err });
        // Resolve with an empty map so waiters never hang.
        resolve(new Map());
        publishReconciliationSettled(true);
      });
  }, [
    adapter,
    db,
    publishCanonicalKind,
    publishCanonicalMapping,
    publishReconciliationSettled,
    worktreesBridge,
  ]);

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
          managedWorktreePathsKnownRef,
          managedWorktreePathsRef,
          publishCanonicalKind,
          publishCanonicalMapping,
          worktreesBridge,
        });
      };
      // Serialize registrations so two adds for the same path cannot interleave
      // their SELECT/INSERT and double-insert. performRootRegistration never
      // rejects, so the chain cannot break.
      const chained = pendingRegistrationsRef.current.then(run);
      pendingRegistrationsRef.current = chained;
      return await chained;
    },
    [awaitBootSettle, publishCanonicalKind, publishCanonicalMapping, worktreesBridge]
  );

  // A folder re-added after removal comes back under its one id (BST-1990), so a
  // folder no longer mounted must leave the maps. Otherwise its re-registration,
  // and the native-index and git-discovery nudges it sends, would be skipped as
  // a repeat of the first, and Explorer search would keep scoping its query to a
  // folder the native index no longer authorizes.
  const syncMountedRoots = useCallback(
    async (current: readonly RootDescriptor[]): Promise<void> => {
      const forgetUnmounted = async (): Promise<void> => {
        await awaitBootSettle();
        const mounted = new Set(current.flatMap((root) => [root.rootId, root.handle.path]));
        for (const key of [...dbRootIdMapRef.current.keys()]) {
          if (!mounted.has(key)) {
            dbRootIdMapRef.current.delete(key);
          }
        }
        setDbRootIdByAdapterRootId((prev) => retainMountedKeys(prev, mounted));
        setDbRootKindByAdapterRootId((prev) => retainMountedKeys(prev, mounted));
      };
      const chained = pendingRegistrationsRef.current.then(forgetUnmounted);
      pendingRegistrationsRef.current = chained;
      await chained;
      for (const root of current) {
        await registerRoot(root);
      }
    },
    [awaitBootSettle, registerRoot]
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

  return {
    dbRootIdByAdapterRootId,
    dbRootKindByAdapterRootId,
    registerRoot,
    resolveDbRootId,
    rootsReconciliationSettled,
    syncMountedRoots,
  };
}
