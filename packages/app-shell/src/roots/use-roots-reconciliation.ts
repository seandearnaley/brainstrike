import { createLogger } from '@brainstrike/logging';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangesBridge } from '../changes/changes-bridge';
import { useChangesBridge } from '../workspace-git-services';
import { notifyRootRegistered } from './root-registration-events';
import { mapHostRecordedRoots, type ReconcileRootsResult } from './root-registry';

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
 * composer's Branch row stays stale until something else calls `inventory()`.
 * Root registration is the exact moment a root becomes discoverable, so it is
 * where the one nudge belongs. NOT polling — one call per registration event.
 *
 * Deliberately best-effort: the Changes surface's own `inventory()` remains the
 * authoritative consumer, so a failure here is a WARN, never a thrown boot
 * error. Both failure shapes are reported — a rejected call AND an `ok: false`
 * `BoundaryResult` — so a refused refresh is never silently dropped.
 *
 * `bridge === null` is a host without the Changes bridge (web): there is no
 * desktop inventory to arm, so this is a real no-op and never a stub.
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

// Module-level set of root identities already warned about, so each unmapped
// root only logs once across the lifetime of the app (not per-call).
const warnedUnmappedRoots = new Set<string>();

type DbRootIdMap = Map<string, string>;

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
  /** Told to rebuild the git inventory once the root's row is committed. */
  changes: ChangesBridge | null;
  dbRootIdMap: DbRootIdMap;
  descriptor: RootDescriptor;
  publishCanonicalKind: (adapterRootId: string, kind: string) => void;
  /** Publishes the canonical adapter-rootId → DB-rootId pair to reactive state. */
  publishCanonicalMapping: (adapterRootId: string, dbRootId: string) => void;
}

interface ApplyBootReconciliationResultArgs {
  adapterRoots: readonly RootDescriptor[];
  dbRootIdMapRef: RefObject<DbRootIdMap>;
  publishCanonicalKind: (adapterRootId: string, kind: string) => void;
  publishCanonicalMapping: (adapterRootId: string, dbRootId: string) => void;
  result: ReconcileRootsResult;
}

function applyBootReconciliationResult({
  adapterRoots,
  dbRootIdMapRef,
  publishCanonicalKind,
  publishCanonicalMapping,
  result,
}: ApplyBootReconciliationResultArgs): DbRootIdMap {
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
    // Fires for EVERY successfully-mapped root.
    notifyRootRegistered([descriptor.rootId, descriptor.handle.path]);
  }
  return dbRootIdMap;
}

/**
 * The body of a single mid-session registration, run AFTER the boot settle.
 * Mutates `dbRootIdMap` (the hook's growable ref target) on success. Never throws.
 */
async function performRootRegistration({
  adapter,
  changes,
  descriptor,
  dbRootIdMap,
  publishCanonicalMapping,
  publishCanonicalKind,
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
  if (!adapter.ownsRootRecords) {
    logger.warn('registerRoot skipped: the adapter does not own root records', {
      rootId: descriptor.rootId,
    });
    return;
  }
  try {
    const result = await mapHostRecordedRoots({ adapterRoots: [descriptor] });
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
      refreshGitInventoryAfterRootRegistration(changes);
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
 * adapter.restoreRoots exists and the adapter owns its root records. Errors are logged at
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
}: UseRootsReconciliationArgs): UseRootsReconciliationResult {
  const hasRunRef = useRef(false);

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
  const settlingRef = useRef<PromiseWithResolvers<DbRootIdMap> | null>(null);
  if (settlingRef.current === null) {
    settlingRef.current = Promise.withResolvers<DbRootIdMap>();
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

  // Latest adapter and Changes bridge, read at call time
  // so registerRoot stays identity-stable without stale captures. They are
  // published at commit, never written during render.
  const adapterRef = useRef(adapter);
  const changes = useChangesBridge();
  const changesRef = useRef(changes);
  useLayoutEffect(() => {
    adapterRef.current = adapter;
    changesRef.current = changes;
  }, [adapter, changes]);

  // Merges a canonical adapter→db pair into the reactive snapshot. No-ops when
  // the pair is already present so a re-resolved boot map never churns the Map
  // identity (and therefore never re-renders inverting consumers needlessly).
  // Declared before the boot effect that calls it (avoids a TDZ in the effect's
  // dep array).
  const publishCanonicalMapping = (adapterRootId: string, dbRootId: string): void => {
    setDbRootIdByAdapterRootId((prev) => {
      if (prev.get(adapterRootId) === dbRootId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(adapterRootId, dbRootId);
      return next;
    });
  };
  const publishCanonicalKind = (adapterRootId: string, kind: string): void => {
    setDbRootKindByAdapterRootId((prev) => {
      if (prev.get(adapterRootId) === kind) {
        return prev;
      }
      const next = new Map(prev);
      next.set(adapterRootId, kind);
      return next;
    });
  };
  const publishReconciliationSettled = (settled: boolean): void => {
    setRootsReconciliationSettled(settled);
  };

  useEffect(() => {
    if (hasRunRef.current) {
      return;
    }
    let settling = settlingRef.current;
    if (settling === null) {
      // Unreachable (the render phase always initializes the ref); recreate
      // rather than return so the "always settles" contract can't be broken.
      settling = Promise.withResolvers<DbRootIdMap>();
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
      settling = Promise.withResolvers<DbRootIdMap>();
      settlingRef.current = settling;
      settledWithoutRestoreRef.current = false;
      publishReconciliationSettled(false);
    }
    if (!adapter.ownsRootRecords) {
      // Deliberately NOT settled: settling empty here would be permanent
      // (promises resolve once), silently dropping a later real mapping from
      // an adapter that does own its root records.
      return;
    }
    hasRunRef.current = true;

    const { resolve } = settling;

    void adapter
      .restoreRoots()
      .then(async (adapterRoots) => {
        const result = await mapHostRecordedRoots({ adapterRoots });
        const dbRootIdMap = applyBootReconciliationResult({
          adapterRoots,
          dbRootIdMapRef,
          publishCanonicalKind,
          publishCanonicalMapping,
          result,
        });
        // Host restoration can write roots after Main's eager inventory build,
        // and those roots still need discovery (BST-1990: missing branch
        // badges in the folders panel).
        if (dbRootIdMap.size > 0) {
          refreshGitInventoryAfterRootRegistration(changesRef.current);
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
  }, [adapter, publishCanonicalKind, publishCanonicalMapping, publishReconciliationSettled]);

  // Reads the settling ref at call time (the effect may have re-keyed it when
  // a restoreRoots-capable adapter replaced an incapable one). The null case
  // is unreachable — the render phase initializes the ref before any consumer
  // can obtain these callbacks — and throwing keeps the "always settles"
  // contract honest instead of hanging on a fresh promise.
  const awaitBootSettle = async (): Promise<void> => {
    const settling = settlingRef.current;
    if (settling === null) {
      throw new Error('roots reconciliation awaited before settling promise initialization');
    }
    await settling.promise;
  };

  const registerRoot = async (descriptor: RootDescriptor): Promise<void> => {
    const run = async (): Promise<void> => {
      // Ordering: the boot reconcile wins races — never write before it settles.
      await awaitBootSettle();
      await performRootRegistration({
        adapter: adapterRef.current,
        changes: changesRef.current,
        dbRootIdMap: dbRootIdMapRef.current,
        descriptor,
        publishCanonicalKind,
        publishCanonicalMapping,
      });
    };
    // Serialize registrations so two adds for the same path cannot interleave
    // their SELECT/INSERT and double-insert. performRootRegistration never
    // rejects, so the chain cannot break.
    const chained = pendingRegistrationsRef.current.then(run);
    pendingRegistrationsRef.current = chained;
    return await chained;
  };

  // A folder re-added after removal comes back under its one id (BST-1990), so a
  // folder no longer mounted must leave the maps. Otherwise its re-registration,
  // and the git-discovery nudge it sends, would be skipped as a repeat of the first.
  const syncMountedRoots = async (current: readonly RootDescriptor[]): Promise<void> => {
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
  };

  const resolveDbRootId = async (
    rootPath: string,
    adapterRootId?: string | null
  ): Promise<string | null> => {
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
  };

  return {
    dbRootIdByAdapterRootId,
    dbRootKindByAdapterRootId,
    registerRoot,
    resolveDbRootId,
    rootsReconciliationSettled,
    syncMountedRoots,
  };
}
