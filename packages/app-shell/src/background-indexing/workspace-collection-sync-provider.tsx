import {
  defaultBackgroundIndexingEnabled,
  ensureBackgroundIndexingPreferencesHydrated,
  useBackgroundIndexingPreferencesStore,
} from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useVectorPreferencesStore } from '@brainstrike/app-state/stores/vector-preferences-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  applyManagedCacheBatch as applyManagedCacheBatchLocally,
  createDatabasePressureController,
  createPriorityDbHandle,
  type DatabaseWorkSchedulerSnapshot,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  getDesktopDatabaseBridge,
  invalidateManagedCacheEntriesByIdentity as invalidateManagedCacheEntriesByIdentityLocally,
} from '@brainstrike/db';
import { type DbHandle, usePGliteDatabase } from '@brainstrike/db/react';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEventDetail,
  useFileSystem,
} from '@brainstrike/file-explorer-ui/shell';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/indexing-contract/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingPipelineInputs,
} from '@brainstrike/indexing-contract/workspace-indexing-qos';
import { createLogger } from '@brainstrike/logging';
import {
  type DirectoryHandle,
  FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT,
  type FileSystemChange,
} from '@brainstrike/types';
import {
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '@brainstrike/utils';
import { onQueueDrained } from '@brainstrike/utils/browser-events';
import { useSharedEmbeddingRuntime } from '@brainstrike/vector-management';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getAssistantForegroundActivitySnapshot } from '../assistant-foreground-activity';
import { RootIdentityProvider } from '../roots/root-identity-context';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import { boundBackgroundPermitWait } from './background-permit-wait';
import { NativeWorkspaceIndexProvider } from './native-workspace-index-provider';
import { useResyncOnReturnToVisibility } from './use-resync-on-return-to-visibility';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';
import {
  isWorkspaceIndexBlockedError,
  WorkspaceIndexBlockedError,
} from './workspace-index-blocked-error';
import { bootstrapWorkspaceIndexCollection } from './workspace-index-bootstrap-service';
import {
  createCoverageAuditKey,
  createCoverageStatusPatch,
  createUnresolvedRootCoverageMessage,
  readIndexedFileCountsByRoot,
  startWorkspaceCoverageAudit,
  WORKSPACE_COVERAGE_AUDIT_MESSAGE,
} from './workspace-index-coverage-audit-runner';
import { runWorkspaceIndexStageBenchmark } from './workspace-index-debug-benchmark';
import {
  countExpectedWorkspaceIndexFiles,
  readWorkspaceIndexDebugRows,
  readWorkspaceIndexMemorySample,
  shouldExposeWorkspaceIndexDebugApi,
  type WorkspaceIndexDebugApi,
  type WorkspaceIndexDebugDbQuery,
  type WorkspaceIndexDebugSnapshot,
  type WorkspaceIndexDebugSummary,
} from './workspace-index-debug-harness';
import { WorkspaceIndexStageProvider } from './workspace-index-stage-provider';
import {
  type WorkspaceIndexingTriggerOptions as TriggerSyncOptions,
  type WorkspaceIndexingTriggerScope as TriggerSyncScope,
  WorkspaceIndexingCoordinator,
} from './workspace-indexing-coordinator';
import {
  createWorkspaceIndexingQosResolver,
  createWorkspaceIndexingRepositories,
} from './workspace-indexing-runtime';
import { createMountedRootIdentityKey, getActiveRootHandles } from './workspace-root-handles';

const logger = createLogger('WorkspaceCollectionSyncProvider');

export { FILE_EXPLORER_REFRESH_EVENT };

const HIGH_RETAINED_HEAP_RATIO = 0.75;

interface BrowserPerformanceMemory {
  readonly jsHeapSizeLimit?: number;
  readonly usedJSHeapSize?: number;
}

/**
 * The sync service signals foreground-style import progress through `setImporting`.
 * Background indexing intentionally discards it: the global `isImporting` flag is
 * the foreground bulk-import pause switch for collection live queries, and raising
 * it would freeze the collection selector + counts at 0/0 during background work.
 */
const NOOP_SET_IMPORTING = (_active: boolean): void => {
  // intentionally empty — see comment above
};
const BACKGROUND_DATABASE_WORK_OPTIONS = {
  label: 'background indexing',
  priority: 'background',
} as const;
const BACKGROUND_PRESSURE_POLL_MS = 50;
const BACKGROUND_POWER_SNAPSHOT_CACHE_MS = 1000;
const RECENT_USER_INPUT_WINDOW_MS = 30_000;

interface BackgroundIndexingPreferencesPersistApi {
  readonly hasHydrated?: () => boolean;
  readonly onFinishHydration?: (
    listener: (state: ReturnType<typeof useBackgroundIndexingPreferencesStore.getState>) => void
  ) => () => void;
}

function getBackgroundIndexingPreferencesPersistApi():
  | BackgroundIndexingPreferencesPersistApi
  | undefined {
  return (
    useBackgroundIndexingPreferencesStore as typeof useBackgroundIndexingPreferencesStore & {
      persist?: BackgroundIndexingPreferencesPersistApi;
    }
  ).persist;
}

function readBackgroundIndexingPreferencesPersistHydrated(): boolean {
  return getBackgroundIndexingPreferencesPersistApi()?.hasHydrated?.() === true;
}

function subscribeToBackgroundIndexingPreferencesPersistHydration(
  callback: () => void
): () => void {
  return (
    getBackgroundIndexingPreferencesPersistApi()?.onFinishHydration?.(() => {
      callback();
    }) ?? (() => undefined)
  );
}

function createRuntimeUnavailableMessage(missingDependencies: string[]): string {
  if (missingDependencies.length === 0) {
    return 'Background indexing runtime is unavailable.';
  }
  return `Background indexing runtime is unavailable: ${missingDependencies.join(', ')}.`;
}

function createClearedProgressPatch(): Pick<
  WorkspaceCollectionSyncStatusPatch,
  | 'backfillRequestId'
  | 'blockedReason'
  | 'chunkingProgress'
  | 'currentFilePath'
  | 'embeddingProgress'
  | 'importProgress'
  | 'lastError'
  | 'pauseReasons'
  | 'processedFiles'
  | 'queueProgress'
  | 'queuedFiles'
  | 'scanSummary'
> {
  return {
    backfillRequestId: null,
    blockedReason: null,
    chunkingProgress: null,
    currentFilePath: null,
    embeddingProgress: null,
    importProgress: null,
    lastError: null,
    pauseReasons: [],
    processedFiles: 0,
    queuedFiles: 0,
    queueProgress: null,
    scanSummary: null,
  };
}

interface WorkspaceIndexingPowerBridge {
  getSnapshot?: () => Promise<WorkspaceIndexingPowerSnapshot>;
}

interface SyncLoopTarget {
  handle: DirectoryHandle;
  scope: {
    changes?: readonly FileSystemChange[];
    mode: 'full' | 'paths';
  };
}

type ResolvedSyncLoopTargetCandidate = SyncLoopTarget & {
  adapterRootId: string | null;
  dbRootId: string | null;
};

type ResolvedSyncLoopTarget = ResolvedSyncLoopTargetCandidate & { dbRootId: string };

function buildFullSyncTargets(handles: readonly DirectoryHandle[]): SyncLoopTarget[] {
  return handles.map((handle) => ({
    handle,
    scope: { mode: 'full' },
  }));
}

function hasResolvedDbRootId(
  target: ResolvedSyncLoopTargetCandidate
): target is ResolvedSyncLoopTarget {
  return target.dbRootId !== null;
}

// Order targets by ASCENDING indexed file count so the LEAST-covered roots sync
// first: a brand-new (0-file) root, or one whose earlier pass imported nothing,
// is reached before a giant repo that is only partway through its import, and
// before fully-indexed roots that just need a re-scan. Stable (equal coverage
// keeps discovery order). Reading ACTUAL coverage — rather than a session flag —
// means a root whose pass was superseded before importing anything stays at 0
// and keeps its first claim, so one huge root can never starve the others.
function orderTargetsByIndexedCoverage(
  targets: readonly ResolvedSyncLoopTarget[],
  indexedCounts: ReadonlyMap<string, number>
): ResolvedSyncLoopTarget[] {
  return targets
    .map((target, index) => ({ count: indexedCounts.get(target.dbRootId) ?? 0, index, target }))
    .sort((a, b) => a.count - b.count || a.index - b.index)
    .map((entry) => entry.target);
}

function publishNoSyncableTargetStatus(args: {
  collectionId: string;
  deferredRootPaths: readonly string[];
  excludedRootPaths: readonly string[];
  mountedSyncableTargetCount: number;
  orderedTargets: readonly ResolvedSyncLoopTarget[];
  resolvedTargets: readonly ResolvedSyncLoopTargetCandidate[];
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}): void {
  if (args.orderedTargets.length > 0) {
    return;
  }
  const unresolvedTarget = args.resolvedTargets.find((target) => target.dbRootId === null);
  if (unresolvedTarget) {
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: unresolvedTarget.handle.path,
        collectionId: args.collectionId,
        lastError: createUnresolvedRootCoverageMessage(unresolvedTarget.handle.path),
        // Unverifiable, not in-progress: this message asserts coverage CANNOT be
        // verified, so a previously published count must not survive beside it.
        // The omission exception is only for the in-progress audit message.
        state: 'waiting',
        unindexableFileCount: null,
      })
    );
    return;
  }
  const deferredRootPath = args.deferredRootPaths[0];
  if (deferredRootPath) {
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: deferredRootPath,
        collectionId: args.collectionId,
        lastError: createUnresolvedRootCoverageMessage(deferredRootPath),
        // Unverifiable, not in-progress: this message asserts coverage CANNOT be
        // verified, so a previously published count must not survive beside it.
        // The omission exception is only for the in-progress audit message.
        state: 'waiting',
        unindexableFileCount: null,
      })
    );
    return;
  }
  if (args.mountedSyncableTargetCount > 0) {
    return;
  }
  const excludedRootPath = args.excludedRootPaths[0];
  if (excludedRootPath) {
    args.setStatus(
      createCoverageStatusPatch({
        activeRootPath: excludedRootPath,
        collectionId: args.collectionId,
        lastError:
          'No mounted roots are currently indexed. Managed worktrees are excluded by default to avoid duplicate corpus indexing.',
        state: 'waiting',
      })
    );
  }
}

// Read each root's actual indexed file count, then order least-covered-first.
// Skips the query when there is only one root to order (nothing to reorder) or
// when the DB/collection is unavailable. A failed query falls back to discovery
// order (logged) so the ordering optimization never blocks indexing.
async function loadOrderedSyncTargets(args: {
  backgroundDb: DbHandle | null;
  managedCollectionId: string | null;
  syncableTargets: readonly ResolvedSyncLoopTarget[];
}): Promise<ResolvedSyncLoopTarget[]> {
  const { backgroundDb, managedCollectionId, syncableTargets } = args;
  if (syncableTargets.length <= 1 || !(managedCollectionId && backgroundDb)) {
    return orderTargetsByIndexedCoverage(syncableTargets, new Map());
  }
  const indexedCounts = await readIndexedFileCountsByRoot({
    collectionId: managedCollectionId,
    db: backgroundDb,
    rootIds: syncableTargets.map((target) => target.dbRootId),
  }).catch((error) => {
    logger.warn('Coverage-based root ordering query failed; using discovery order', { error });
    return new Map<string, number>();
  });
  return orderTargetsByIndexedCoverage(syncableTargets, indexedCounts);
}

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
  readonly nativeIndexSearch?: IndexSearchCapability | null;
}

function isFileSystemChange(value: unknown): value is FileSystemChange {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate['kind'] === 'file' || candidate['kind'] === 'directory') &&
    (candidate['type'] === 'added' ||
      candidate['type'] === 'removed' ||
      candidate['type'] === 'modified') &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0
  );
}

function isFilteredChangeBoundary(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isWorkspaceRefreshDetail(value: unknown): value is FileExplorerRefreshEventDetail {
  if (!(value && typeof value === 'object')) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !(
      candidate['source'] === 'watcher' ||
      candidate['source'] === 'manual' ||
      candidate['source'] === 'visibility-recovery'
    )
  ) {
    return false;
  }
  if (!(candidate['scope'] === 'incremental' || candidate['scope'] === 'full')) {
    return false;
  }
  if (!Array.isArray(candidate['roots'])) {
    return false;
  }
  return candidate['roots'].every((root) => {
    if (!(root && typeof root === 'object')) {
      return false;
    }
    const rootCandidate = root as Record<string, unknown>;
    const boundaries = rootCandidate['filteredChangeBoundaries'];
    const boundaryOverflow = rootCandidate['filteredChangeBoundariesOverflow'];
    const hasValidFilteredEvidence =
      boundaries === undefined
        ? boundaryOverflow === undefined
        : Array.isArray(boundaries) &&
          boundaries.length > 0 &&
          boundaries.length <= FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT &&
          boundaries.every(isFilteredChangeBoundary) &&
          (boundaryOverflow === undefined || boundaryOverflow === true);
    return (
      typeof rootCandidate['rootId'] === 'string' &&
      rootCandidate['rootId'].length > 0 &&
      typeof rootCandidate['rootPath'] === 'string' &&
      hasValidFilteredEvidence &&
      Array.isArray(rootCandidate['changes']) &&
      rootCandidate['changes'].every(isFileSystemChange)
    );
  });
}

function parseRefreshSyncScope(event: Event): TriggerSyncScope | null {
  if (!(event instanceof CustomEvent)) {
    return { mode: 'full' };
  }
  if (!isWorkspaceRefreshDetail(event.detail)) {
    return { mode: 'full' };
  }
  if (event.detail.source !== 'watcher') {
    return { mode: 'full' };
  }
  if (event.detail.roots.length === 0) {
    return { mode: 'full' };
  }
  if (event.detail.scope === 'full') {
    // Watcher overflow ('unknown' observer records): events may have been
    // missed for the NAMED roots, so each needs a full resync — but roots not
    // named in the event keep their state; this must not fan out workspace-wide.
    return {
      mode: 'paths',
      roots: event.detail.roots.map((root) => ({
        changes: root.changes,
        fullResync: true,
        rootId: root.rootId,
      })),
    };
  }
  const rootsWithDetailedChanges = event.detail.roots.filter((root) => root.changes.length > 0);
  if (rootsWithDetailedChanges.length === 0) {
    // Filtered-boundary metadata is working-tree evidence for Git views, not
    // watcher record loss. No detailed path reached the indexer, so there is
    // no indexing work and no justification for full-recovery work.
    return null;
  }
  return {
    mode: 'paths',
    roots: rootsWithDetailedChanges.map((root) => ({
      changes: root.changes,
      rootId: root.rootId,
    })),
  };
}

function buildPathSyncTargets(args: {
  allHandles: readonly DirectoryHandle[];
  rootIdByPath: ReadonlyMap<string, string>;
  scope: Extract<TriggerSyncScope, { mode: 'paths' }>;
}): SyncLoopTarget[] {
  const targetByRootId = new Map<string, SyncLoopTarget>();
  for (const handle of args.allHandles) {
    const rootId = handle.rootId ?? args.rootIdByPath.get(handle.path);
    if (!rootId) {
      continue;
    }
    targetByRootId.set(rootId, {
      handle,
      scope: { changes: [], mode: 'paths' },
    });
  }
  for (const root of args.scope.roots) {
    const target = targetByRootId.get(root.rootId);
    if (!target) {
      continue;
    }
    if (root.fullResync === true || target.scope.mode === 'full') {
      // Overflow: this root's incremental changes are untrustworthy — a full
      // resync supersedes any accumulated per-path scope.
      targetByRootId.set(root.rootId, {
        handle: target.handle,
        scope: { mode: 'full' },
      });
      continue;
    }
    const existingChanges = target.scope.changes ?? [];
    targetByRootId.set(root.rootId, {
      handle: target.handle,
      scope: {
        changes: [...existingChanges, ...root.changes],
        mode: 'paths',
      },
    });
  }
  return [...targetByRootId.values()].filter(
    (target) =>
      target.scope.mode === 'full' ||
      (target.scope.mode === 'paths' && (target.scope.changes?.length ?? 0) > 0)
  );
}

function buildSyncLoopTargets(args: {
  rootDirectoryHandle: DirectoryHandle;
  rootDirectoryHandles: readonly DirectoryHandle[];
  rootIdByPath: ReadonlyMap<string, string>;
  scope: TriggerSyncScope;
}): SyncLoopTarget[] {
  const allHandles =
    args.rootDirectoryHandles.length > 0 ? args.rootDirectoryHandles : [args.rootDirectoryHandle];
  if (args.scope.mode === 'full') {
    return buildFullSyncTargets(allHandles);
  }
  const pathTargets = buildPathSyncTargets({
    allHandles,
    rootIdByPath: args.rootIdByPath,
    scope: args.scope,
  });
  if (pathTargets.length > 0) {
    return pathTargets;
  }
  logger.warn('Watcher refresh referenced no active workspace roots; running full recovery sync', {
    rootIds: args.scope.roots.map((root) => root.rootId),
  });
  return buildFullSyncTargets(allHandles);
}

interface SyncTargetSelection {
  deferredRootPaths: string[];
  excludedRootPaths: string[];
  targets: SyncLoopTarget[];
}

interface ExcludedRootLogState {
  loggedRootPaths: Set<string>;
  rootSetKey: string;
}

function filterSyncTargetsByIndexingDefault(
  targets: readonly SyncLoopTarget[],
  dbRootKindByAdapterRootId: ReadonlyMap<string, string>,
  dbRootIdByAdapterRootId: ReadonlyMap<string, string>,
  worktreeRootIndexingOptInById: Readonly<Record<string, true>>,
  rootsReconciliationSettled: boolean
): SyncTargetSelection {
  if (!rootsReconciliationSettled) {
    return {
      deferredRootPaths: targets.map((target) => target.handle.path),
      excludedRootPaths: [],
      targets: [],
    };
  }
  const deferredRootPaths: string[] = [];
  const excludedRootPaths: string[] = [];
  const selectedTargets: SyncLoopTarget[] = [];
  for (const target of targets) {
    const rootPath = target.handle.path;
    const rootId = target.handle.rootId;
    if (!rootId) {
      selectedTargets.push(target);
      continue;
    }
    const kind = dbRootKindByAdapterRootId.get(rootId);
    if (kind === undefined) {
      deferredRootPaths.push(rootPath);
      logger.debug('Deferring sync target with unknown root kind pending registration', {
        rootId,
        rootPath,
      });
      continue;
    }
    // This deliberately throws for a future/invalid persisted kind, even from
    // an effect or event path: NO SILENT FALLBACKS forbids guessing whether an
    // unrecognized root should be indexed.
    const dbRootId = dbRootIdByAdapterRootId.get(rootId);
    if (
      defaultBackgroundIndexingEnabled(kind) ||
      (kind === 'worktree' && dbRootId !== undefined && worktreeRootIndexingOptInById[dbRootId])
    ) {
      selectedTargets.push(target);
      continue;
    }
    excludedRootPaths.push(rootPath);
  }
  return { deferredRootPaths, excludedRootPaths, targets: selectedTargets };
}

function logExcludedRootsOncePerRootSet(args: {
  excludedRootPaths: readonly string[];
  previous: ExcludedRootLogState;
  rootSetKey: string;
}): ExcludedRootLogState {
  const next =
    args.previous.rootSetKey === args.rootSetKey
      ? args.previous
      : { loggedRootPaths: new Set<string>(), rootSetKey: args.rootSetKey };
  for (const rootPath of args.excludedRootPaths) {
    if (next.loggedRootPaths.has(rootPath)) {
      continue;
    }
    next.loggedRootPaths.add(rootPath);
    logger.info('Excluded worktree root from background indexing by default', { rootPath });
  }
  return next;
}

function createWaitForBackgroundPermit(
  db: DbHandle
): (options: { readonly label: string }) => Promise<void> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return boundBackgroundPermitWait(
      createDatabasePressureController({ scheduler }).waitForBackgroundPermit
    );
  }

  const schedulerSnapshot = getDesktopDatabaseBridge()?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Background indexing requires database QoS scheduler snapshots.');
  }

  return boundBackgroundPermitWait(
    createDatabasePressureController({
      pollMs: BACKGROUND_PRESSURE_POLL_MS,
      snapshotSource: {
        getSnapshot: schedulerSnapshot,
      },
    }).waitForBackgroundPermit
  );
}

function toWorkspaceIndexingDatabasePressure(
  snapshot: DatabaseWorkSchedulerSnapshot
): WorkspaceIndexingDatabasePressure {
  const waitingReason = getDatabasePressureWaitingReason(snapshot);
  const normalPressure = waitingReason?.startsWith('normal-') === true;
  return {
    available: true,
    foregroundPressure: waitingReason !== null && !normalPressure,
    normalPressure,
  };
}

function createReadDatabasePressure(
  db: DbHandle
): () => Promise<WorkspaceIndexingDatabasePressure> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return async () => toWorkspaceIndexingDatabasePressure(scheduler.getSnapshot());
  }

  const schedulerSnapshot = getDesktopDatabaseBridge()?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Workspace Index QoS requires database scheduler snapshots.');
  }

  return async () => toWorkspaceIndexingDatabasePressure(await schedulerSnapshot());
}

function readRendererMemoryPressure(): WorkspaceIndexingPipelineInputs['memory'] {
  const memory = (globalThis.performance as Performance & { memory?: BrowserPerformanceMemory })
    .memory;
  const used = memory?.usedJSHeapSize;
  const limit = memory?.jsHeapSizeLimit;
  if (
    typeof used !== 'number' ||
    typeof limit !== 'number' ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return { available: false };
  }
  const retainedHeapRatio = used / limit;
  return {
    available: true,
    pressure: retainedHeapRatio >= HIGH_RETAINED_HEAP_RATIO ? 'high' : 'normal',
    retainedHeapRatio,
  };
}

function createReadPipelineInputs(db: DbHandle): () => Promise<WorkspaceIndexingPipelineInputs> {
  return async () => {
    const result = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
         FROM job_queue
        WHERE queue = 'embeddings'
          AND job_type = 'embed_chunk'
          AND state IN ('queued', 'running')`
    );
    const rawCount = result.rows[0]?.count;
    const activeEmbeddingJobs = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? 0);
    if (!Number.isFinite(activeEmbeddingJobs) || activeEmbeddingJobs < 0) {
      throw new Error('Workspace Index QoS received an invalid embedding queue depth.');
    }
    return {
      accelerator: { available: false },
      memory: readRendererMemoryPressure(),
      progress: { available: false },
      queueDepth: {
        activeEmbeddingJobs,
        available: true,
      },
    };
  };
}

function createReadPowerSnapshot(): (() => Promise<WorkspaceIndexingPowerSnapshot>) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { power?: WorkspaceIndexingPowerBridge }).power;
  const getSnapshot = bridge?.getSnapshot;
  if (typeof getSnapshot !== 'function') {
    return null;
  }
  return createCachedSnapshotReader(
    async () => assertValidWorkspaceIndexingPowerSnapshot(await getSnapshot()),
    BACKGROUND_POWER_SNAPSHOT_CACHE_MS
  );
}

function createCachedSnapshotReader<TSnapshot>(
  readSnapshot: () => TSnapshot | Promise<TSnapshot>,
  cacheMs: number,
  now: () => number = () => Date.now()
): () => Promise<TSnapshot> {
  let cachedSnapshot: TSnapshot | null = null;
  let cachedAt = 0;
  let pendingSnapshot: Promise<TSnapshot> | null = null;
  return async () => {
    const readAt = now();
    if (cachedSnapshot && readAt - cachedAt <= cacheMs) {
      return cachedSnapshot;
    }
    if (pendingSnapshot) {
      return pendingSnapshot;
    }
    cachedSnapshot = null;
    cachedAt = 0;
    pendingSnapshot = Promise.resolve()
      .then(readSnapshot)
      .then((snapshot) => {
        cachedSnapshot = snapshot;
        cachedAt = now();
        return snapshot;
      });
    try {
      return await pendingSnapshot;
    } finally {
      pendingSnapshot = null;
    }
  };
}

function useDocumentVisibility(): boolean {
  const readVisibility = (): boolean =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible';
  const [visible, setVisible] = useState(readVisibility);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = (): void => {
      setVisible(readVisibility());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return visible;
}

function useRecentUserInputMsReader(): () => number | null {
  const lastInputRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const recordInput = (): void => {
      lastInputRef.current = Date.now();
    };
    const inputEvents = ['keydown', 'pointerdown', 'wheel'] as const;
    for (const eventName of inputEvents) {
      window.addEventListener(eventName, recordInput, { passive: true });
    }
    return () => {
      for (const eventName of inputEvents) {
        window.removeEventListener(eventName, recordInput);
      }
    };
  }, []);

  return useCallback((): number | null => {
    const lastInputAt = lastInputRef.current;
    if (lastInputAt === null) {
      return null;
    }
    const inputAgeMs = Math.max(0, Date.now() - lastInputAt);
    return inputAgeMs > RECENT_USER_INPUT_WINDOW_MS ? null : inputAgeMs;
  }, []);
}

export function WorkspaceCollectionSyncProvider({
  children,
  nativeIndexSearch,
}: WorkspaceCollectionSyncProviderProps) {
  if (nativeIndexSearch) {
    return (
      <NativeWorkspaceIndexProvider capability={nativeIndexSearch}>
        <WorkspaceIndexStageProvider native />
        {children}
      </NativeWorkspaceIndexProvider>
    );
  }
  return (
    <LegacyWorkspaceCollectionSyncProvider>
      <WorkspaceIndexStageProvider />
      {children}
    </LegacyWorkspaceCollectionSyncProvider>
  );
}

function LegacyWorkspaceCollectionSyncProvider({ children }: { readonly children: ReactNode }) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle, rootDirectoryHandles, rootIdByPath } =
    useFileSystem();
  // BST-1268: per-thread workspaces restore the FOCUSED root on thread
  // switch, and the reducer's add-or-focus rebuilds handle/array/map
  // identities without changing the root SET. triggerSync must not be
  // recreated on focus-only changes — its owning effect's cleanup cancels an
  // in-flight sync mid-import (see the comment above the sync-loop effect).
  // The callback therefore reads the live values through render-synced refs
  // and keys on the SET identity alone (sorted root ids).
  const rootDirectoryHandleRef = useRef(rootDirectoryHandle);
  const rootDirectoryHandlesRef = useRef(rootDirectoryHandles);
  const rootIdByPathRef = useRef(rootIdByPath);
  // Effect-synced (not render-synced): every consumer is post-render (event
  // listeners, async sync loops, effects declared BELOW this one), so the
  // commit-time sync keeps them fresh without a render-phase ref write.
  useEffect(() => {
    rootDirectoryHandleRef.current = rootDirectoryHandle;
    rootDirectoryHandlesRef.current = rootDirectoryHandles;
    rootIdByPathRef.current = rootIdByPath;
  });
  const rootSetKey = useMemo(
    () =>
      rootDirectoryHandles
        .map((handle) => handle.rootId ?? handle.path)
        .sort()
        .join('|'),
    [rootDirectoryHandles]
  );
  const db = usePGliteDatabase();

  // Root registry: ensure a DB roots row exists for every adapter root.
  // Runs once per boot, before the first sync cycle writes file records.
  // Errors are logged and swallowed — must never block boot.
  // The returned callbacks are ref-stable: identity does not change when the
  // reconciliation map resolves, so the service useMemo is not reconstructed.
  const {
    registerRoot,
    resolveDbRootId,
    dbRootIdByAdapterRootId,
    dbRootKindByAdapterRootId,
    rootsReconciliationSettled,
  } = useRootsReconciliation({ adapter: fileSystemAdapter, db });
  // Unlike focus-only handle changes, a genuine kind-map change MUST recreate
  // triggerSync so the owning effect restarts a pass that deferred an unknown
  // root while its registration was in flight.
  const excludedRootLogStateRef = useRef<ExcludedRootLogState>({
    loggedRootPaths: new Set(),
    rootSetKey,
  });
  // Mid-session root registration (phase 5): roots added via Add Folder get
  // their DB roots row at add time, so their imports write real root_id values
  // immediately instead of NULL-until-next-boot. registerRoot awaits the boot
  // settle and no-ops on already-mapped paths, so calling it for boot-restored
  // handles is safe — this ref only prevents duplicate CALLS per rootId.
  //
  // NOTE: this effect is declared BEFORE the triggerSync effect below so the
  // registration is enqueued before the sync loop starts; resolveDbRootId
  // awaits enqueued registrations, so the new root's first import sees its id.
  const registrationAttemptedRootIdsRef = useRef(new Set<string>());
  // biome-ignore lint/plugin: Lifecycle registration reconciles local root capabilities; it is not remote data fetching.
  useEffect(() => {
    for (const handle of rootDirectoryHandles) {
      // Prefer the stamped handle.rootId — the path→id map collides for
      // same-named web roots, so it would mis-attribute one root's imports.
      const rootId = handle.rootId ?? rootIdByPath.get(handle.path);
      if (rootId === undefined || registrationAttemptedRootIdsRef.current.has(rootId)) {
        // No durable identity yet (legacy setRoot path) → nothing to register;
        // the boot reconcile owns identity for restored roots.
        continue;
      }
      registrationAttemptedRootIdsRef.current.add(rootId);
      // Fire-and-forget: registerRoot never rejects (failures are logged and
      // swallowed inside the hook). The cost of a failed registration is that
      // THIS session's imports for the root write root_id = NULL (no retry —
      // the rootId stays in the attempted set above); the boot reconcile
      // self-heals it next launch, since it reconciles ALL adapter roots.
      void registerRoot({
        displayName: handle.name,
        handle,
        kind: fileSystemAdapter.platform === 'electron' ? 'path' : 'fsa',
        // The handle is live in this session: the only routes into
        // rootDirectoryHandles are addRoot / restoreRoots-driven flows the
        // user has just granted.
        permissionState: 'granted',
        // The useFileSystem surface does not expose per-root persisted state,
        // so reconstruct it: handles reach this list via addRoot or the
        // restore flows, and both persist the handle to the backing store in
        // the normal case. The one exception — web addRoot returning
        // persisted:false after a failed IndexedDB write — is invisible here,
        // so such a root may be registered even though its id won't survive
        // reload (worst case: one orphaned roots row, no cascade impact).
        // Accepted tradeoff per the phase 5 plan.
        persisted: true,
        rootId,
      });
    }
  }, [fileSystemAdapter, registerRoot, rootDirectoryHandles, rootIdByPath]);

  const backgroundDb = useMemo(() => (db ? createPriorityDbHandle(db, 'background') : null), [db]);
  const waitForBackgroundPermit = useMemo(
    () => (backgroundDb ? createWaitForBackgroundPermit(backgroundDb) : null),
    [backgroundDb]
  );
  const readDatabasePressure = useMemo(
    () => (backgroundDb ? createReadDatabasePressure(backgroundDb) : null),
    [backgroundDb]
  );
  const readPipelineInputs = useMemo(
    () => (backgroundDb ? createReadPipelineInputs(backgroundDb) : null),
    [backgroundDb]
  );
  const readPowerSnapshot = useMemo(() => createReadPowerSnapshot(), []);
  const backgroundRepositories = useMemo(
    () => (backgroundDb ? createWorkspaceIndexingRepositories(backgroundDb) : null),
    [backgroundDb]
  );
  const { ensureStarted: ensureChunkingWorker } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const storeHasHydrated = useBackgroundIndexingPreferencesStore((state) => state.hasHydrated);
  const persistHasHydrated = useSyncExternalStore(
    subscribeToBackgroundIndexingPreferencesPersistHydration,
    readBackgroundIndexingPreferencesPersistHydrated,
    () => false
  );
  const hasHydrated = storeHasHydrated || persistHasHydrated;
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const setManagedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.setManagedCollectionId
  );
  const indexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.indexingPolicyPreset
  );
  const setIndexingPolicyPreset = useBackgroundIndexingPreferencesStore(
    (state) => state.setIndexingPolicyPreset
  );
  const paused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const worktreeRootIndexingOptInById = useBackgroundIndexingPreferencesStore(
    (state) => state.worktreeRootIndexingOptInById
  );
  const setWorktreeRootIndexingState = useBackgroundIndexingPreferencesStore(
    (state) => state.setWorktreeRootIndexingState
  );
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);

  useEffect(() => {
    if (!(hasHydrated && rootsReconciliationSettled)) {
      setWorktreeRootIndexingState([]);
      return;
    }
    const mountedHandles = getActiveRootHandles({
      rootDirectoryHandle: rootDirectoryHandleRef.current,
      rootDirectoryHandles: rootDirectoryHandlesRef.current,
    });
    setWorktreeRootIndexingState(
      mountedHandles.flatMap((handle) => {
        const adapterRootId = handle.rootId ?? rootIdByPathRef.current.get(handle.path);
        if (!(adapterRootId && dbRootKindByAdapterRootId.get(adapterRootId) === 'worktree')) {
          return [];
        }
        const dbRootId = dbRootIdByAdapterRootId.get(adapterRootId);
        if (!dbRootId) {
          return [];
        }
        return [
          {
            adapterRootId,
            dbRootId,
            indexed: worktreeRootIndexingOptInById[dbRootId] === true,
          },
        ];
      })
    );
  }, [
    dbRootIdByAdapterRootId,
    dbRootKindByAdapterRootId,
    hasHydrated,
    rootSetKey,
    rootsReconciliationSettled,
    setWorktreeRootIndexingState,
    worktreeRootIndexingOptInById,
  ]);
  const selectedDevicePreference = useVectorPreferencesStore((state) => ({
    devicePref: state.devicePref,
    devicePrefConfigured: state.devicePrefConfigured,
    hasHydrated: state.hasHydrated,
    reinitEveryN: state.reinitEveryN,
    verboseOrtLogs: state.verboseOrtLogs,
  }));
  const { controller: runtimeController, service: vectorQueueService } =
    useSharedEmbeddingRuntime();
  const windowVisible = useDocumentVisibility();
  const readRecentUserInputMs = useRecentUserInputMsReader();
  const windowVisibleRef = useRef(windowVisible);
  windowVisibleRef.current = windowVisible;
  const workspaceIndexBootstrapInFlightRef = useRef(false);
  const syncLoopDebugRef = useRef<Record<string, unknown>>({ state: 'not-started' });
  const [indexingCoordinator] = useState(() => new WorkspaceIndexingCoordinator());
  const reportAsyncError = useCallback(
    (_operation: string, error: unknown): void => {
      // No direct logger call: the status store's subscription durably logs
      // the error/blocked transition set below (BST-1257) — logging here too
      // recorded every incident twice under different scopes.
      // Focused path read live via ref (BST-1268): a focus-only change must
      // not change this callback's identity — the teardown-detach effect and
      // triggerSync both depend on it.
      const activeRootPath = rootDirectoryHandleRef.current?.path ?? null;
      if (isWorkspaceIndexBlockedError(error)) {
        setSyncStatus({
          activeRootPath,
          managedCollectionId,
          managedCollectionName: null,
          state: 'blocked',
          ...createClearedProgressPatch(),
          blockedReason: error.blockedReason,
          lastError: error.message,
        });
        return;
      }
      setSyncStatus({
        activeRootPath,
        blockedReason: null,
        currentFilePath: null,
        lastError: error instanceof Error ? error.message : String(error),
        managedCollectionId,
        managedCollectionName: null,
        processedFiles: 0,
        queuedFiles: 0,
        state: 'error',
      });
    },
    [managedCollectionId, setSyncStatus]
  );
  useEffect(() => {
    if (storeHasHydrated) {
      return;
    }
    let disposed = false;
    void ensureBackgroundIndexingPreferencesHydrated().catch((error) => {
      if (!disposed) {
        reportAsyncError('preferences hydration', error);
      }
    });
    return () => {
      disposed = true;
    };
  }, [reportAsyncError, storeHasHydrated]);

  // Root access and DB reconciliation are the indexing readiness contract.
  // The indexer reads the filesystem directly; tree loading and expansion
  // restoration are presentation work and must neither gate nor cancel it.

  const validateHostedProviderAccess = useCallback(
    async (embeddingSetId: string): Promise<void> => {
      if (!vectorQueueService) {
        throw new Error('Vector queue service is unavailable.');
      }
      const validation = await vectorQueueService.validateApiKeyForSet(embeddingSetId);
      if (!validation.valid) {
        if (validation.reason === 'missing-provider-key') {
          throw new WorkspaceIndexBlockedError('missing-provider-key', validation.message);
        }
        throw new Error(validation.message);
      }
    },
    [vectorQueueService]
  );

  const ensureEmbeddingRuntimeStarted = useCallback(async (): Promise<void> => {
    const status = await runtimeController.ensureStarted();
    if (status.state === 'error') {
      throw new Error(status.lastError ?? 'Embedding runtime is unavailable.');
    }
  }, [runtimeController]);

  // One transition tracker per provider instance: resolver reconstruction must
  // not turn an unchanged QoS state into a fresh transition log.
  const [observeQosTransition] = useState(() =>
    createWorkspaceIndexingQosTransitionLogger('app-shell-sync')
  );
  const resolveQosPolicy = useCallback(
    (options?: { foregroundDbPressureStarvationBypass?: boolean }) =>
      createWorkspaceIndexingQosResolver({
        observeTransition: observeQosTransition,
        readBackgroundIndexingPaused: () =>
          getBackgroundWorkArbiterSnapshot().backgroundIndexingPaused,
        readDatabasePressure,
        readForegroundQueryActive: getAssistantForegroundActivitySnapshot,
        readPipelineInputs,
        readPowerSnapshot,
        readRecentUserInputMs,
        readWindowVisible: () => windowVisibleRef.current,
      })(options),
    [
      observeQosTransition,
      readDatabasePressure,
      readPipelineInputs,
      readPowerSnapshot,
      readRecentUserInputMs,
    ]
  );

  const missingRuntimeDependencies = useMemo(() => {
    const missing: string[] = [];
    if (!db) {
      missing.push('db');
    }
    if (!backgroundDb) {
      missing.push('backgroundDb');
    }
    if (!waitForBackgroundPermit) {
      missing.push('waitForBackgroundPermit');
    }
    if (backgroundRepositories) {
      if (!backgroundRepositories.fileRecordRepository) {
        missing.push('fileRecordRepository');
      }
      if (!backgroundRepositories.chunkRepository) {
        missing.push('chunkRepository');
      }
      if (!backgroundRepositories.embeddingSetsRepository) {
        missing.push('embeddingSetsRepository');
      }
    } else {
      missing.push('backgroundRepositories');
    }
    if (!fileSystemAdapter) {
      missing.push('fileSystemAdapter');
    }
    return missing;
  }, [backgroundDb, backgroundRepositories, db, fileSystemAdapter, waitForBackgroundPermit]);

  const service = useMemo(() => {
    if (
      !(
        db &&
        backgroundDb &&
        waitForBackgroundPermit &&
        backgroundRepositories &&
        fileSystemAdapter &&
        backgroundRepositories.fileRecordRepository &&
        backgroundRepositories.chunkRepository &&
        backgroundRepositories.embeddingSetsRepository
      )
    ) {
      return null;
    }
    const recordSyncDependencyStage = (stage: string, extra?: Record<string, unknown>): void => {
      syncLoopDebugRef.current = {
        ...syncLoopDebugRef.current,
        ...(extra ?? {}),
        dependencyStage: stage,
        dependencyUpdatedAt: new Date().toISOString(),
      };
    };
    // Always-on, ref-only diagnostics keep production failures explainable.
    // The data is exposed only when the Workspace Index debug API is enabled.
    const embeddingSetsRepository = new Proxy(backgroundRepositories.embeddingSetsRepository, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'getById' || typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          recordSyncDependencyStage('embeddingSetsRepository.getById:start', {
            embeddingSetId: args[0],
          });
          try {
            const result = await value.apply(target, args);
            recordSyncDependencyStage('embeddingSetsRepository.getById:done', {
              embeddingSetFound: Boolean(result),
              embeddingSetId: args[0],
            });
            return result;
          } catch (error) {
            recordSyncDependencyStage('embeddingSetsRepository.getById:error', {
              embeddingSetId: args[0],
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        };
      },
    }) as typeof backgroundRepositories.embeddingSetsRepository;
    return new WorkspaceCollectionSyncService({
      applyManagedCacheBatch: async (args) => {
        const electronApplyManagedCacheBatch = getDesktopDatabaseBridge()?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      },
      cancelBackfill: async (embeddingSetId) => {
        recordSyncDependencyStage('cancelBackfill:start', { embeddingSetId });
        try {
          await runtimeController.cancelBackfill(embeddingSetId);
          recordSyncDependencyStage('cancelBackfill:done', { embeddingSetId });
        } catch (error) {
          recordSyncDependencyStage('cancelBackfill:error', {
            embeddingSetId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      chunkRepository: backgroundRepositories.chunkRepository,
      db: backgroundDb,
      embeddingSetsRepository,
      enqueueBackfill: async (embeddingSetId, options) =>
        await runtimeController.enqueueBackfill(embeddingSetId, options),
      ensureChunkingWorker,
      ensureEmbeddingRuntimeStarted,
      fileRecordRepository: backgroundRepositories.fileRecordRepository,
      fileSystemAdapter,
      getBackfillsInFlight: async () => {
        recordSyncDependencyStage('getBackfillsInFlight:start');
        try {
          const result = await runtimeController.getBackfillsInFlight();
          recordSyncDependencyStage('getBackfillsInFlight:done', {
            inFlightBackfillCount: result.length,
          });
          return result;
        } catch (error) {
          recordSyncDependencyStage('getBackfillsInFlight:error', {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      invalidateManagedCacheEntriesByIdentity: async (args) => {
        const electronInvalidateManagedCacheEntries =
          getDesktopDatabaseBridge()?.invalidateManagedCacheEntriesByIdentity;
        if (electronInvalidateManagedCacheEntries) {
          return await electronInvalidateManagedCacheEntries(
            args,
            BACKGROUND_DATABASE_WORK_OPTIONS
          );
        }
        return await invalidateManagedCacheEntriesByIdentityLocally(backgroundDb, args);
      },
      log: logger,
      onDebugStage: (stage, details) => {
        syncLoopDebugRef.current = {
          ...syncLoopDebugRef.current,
          ...(details ?? {}),
          serviceStage: stage,
          serviceStageUpdatedAt: new Date().toISOString(),
        };
      },
      onManagedCollectionMissing: (missingCollectionId) => {
        if (
          useBackgroundIndexingPreferencesStore.getState().managedCollectionId ===
          missingCollectionId
        ) {
          setManagedCollectionId(null);
        }
      },
      resolveDbRootId,
      resolveQosPolicy,
      // Background indexing must NOT raise the foreground `isImporting` pause flag:
      // that flag gates the collection selector + count live queries
      // (liveQueryEnabled = !isImporting), so toggling it freezes the file/chunk
      // counts the user is watching at 0/0 for the whole import. Background progress
      // is reported through the workspace-sync status store instead.
      setImporting: NOOP_SET_IMPORTING,
      setStatus: setSyncStatus,
      subscribeToBackfillProgress: (callback) => runtimeController.onBackfillProgress(callback),
      symbolRepository: backgroundRepositories.symbolRepository,
      validateHostedProviderAccess,
      waitForBackgroundPermit,
    });
  }, [
    backgroundDb,
    backgroundRepositories,
    db,
    ensureEmbeddingRuntimeStarted,
    ensureChunkingWorker,
    fileSystemAdapter,
    resolveDbRootId,
    resolveQosPolicy,
    runtimeController,
    setManagedCollectionId,
    setSyncStatus,
    validateHostedProviderAccess,
    waitForBackgroundPermit,
  ]);

  const triggerWorkspaceIndexBootstrap = useCallback((): boolean => {
    if (!(enabled && managedCollectionId === null)) {
      return false;
    }
    if (workspaceIndexBootstrapInFlightRef.current) {
      return true;
    }

    const embeddingSetsRepository = backgroundRepositories?.embeddingSetsRepository;
    if (!embeddingSetsRepository) {
      reportAsyncError(
        'bootstrap',
        new Error('Background indexing embedding set repository is unavailable.')
      );
      return true;
    }

    workspaceIndexBootstrapInFlightRef.current = true;
    // Bootstrap publishes the collection id through preferences. That update
    // re-runs triggerSync, which owns setup/paused/scanning status. Writing a
    // second status after bootstrap resolves can overwrite that newer state.
    void bootstrapWorkspaceIndexCollection(
      { enabled, managedCollectionId },
      {
        embeddingSetsRepository,
        setManagedCollectionId: (collectionId) => {
          const current = useBackgroundIndexingPreferencesStore.getState();
          if (current.enabled && current.managedCollectionId === null) {
            current.setManagedCollectionId(collectionId);
          }
        },
      }
    )
      .catch((error) => {
        reportAsyncError('bootstrap', error);
      })
      .finally(() => {
        workspaceIndexBootstrapInFlightRef.current = false;
      });
    return true;
  }, [backgroundRepositories, enabled, managedCollectionId, reportAsyncError]);

  const resolveSyncTargets = useCallback(
    async (scope: TriggerSyncScope, context: { isCurrent: () => boolean }) => {
      if (!(service && managedCollectionId)) {
        return [];
      }
      const rootDirectoryHandle = rootDirectoryHandleRef.current;
      const rootDirectoryHandles = rootDirectoryHandlesRef.current;
      const rootIdByPath = rootIdByPathRef.current;
      if (!rootDirectoryHandle) {
        return [];
      }

      const selection = filterSyncTargetsByIndexingDefault(
        buildSyncLoopTargets({
          rootDirectoryHandle,
          rootDirectoryHandles,
          rootIdByPath,
          scope,
        }),
        dbRootKindByAdapterRootId,
        dbRootIdByAdapterRootId,
        worktreeRootIndexingOptInById,
        rootsReconciliationSettled
      );
      const mountedHandles = getActiveRootHandles({
        rootDirectoryHandle,
        rootDirectoryHandles,
      });
      const workspaceSelection = filterSyncTargetsByIndexingDefault(
        buildFullSyncTargets(mountedHandles),
        dbRootKindByAdapterRootId,
        dbRootIdByAdapterRootId,
        worktreeRootIndexingOptInById,
        rootsReconciliationSettled
      );
      excludedRootLogStateRef.current = logExcludedRootsOncePerRootSet({
        excludedRootPaths: selection.excludedRootPaths,
        previous: excludedRootLogStateRef.current,
        rootSetKey,
      });

      const resolvedMountedRoots = await Promise.all(
        mountedHandles.map(async (handle) => {
          const adapterRootId = handle.rootId ?? rootIdByPath.get(handle.path);
          return {
            adapterRootId: adapterRootId ?? null,
            dbRootId: await resolveDbRootId(handle.path, adapterRootId),
            identityKey: createMountedRootIdentityKey(handle, rootIdByPath),
            rootPath: handle.path,
          };
        })
      );
      if (!context.isCurrent()) {
        return [];
      }
      const mountedDbRootIdByIdentity = new Map(
        resolvedMountedRoots.map((root) => [root.identityKey, root.dbRootId])
      );
      const resolvedTargets = selection.targets.map(
        (target): ResolvedSyncLoopTargetCandidate => ({
          ...target,
          adapterRootId: target.handle.rootId ?? rootIdByPath.get(target.handle.path) ?? null,
          dbRootId:
            mountedDbRootIdByIdentity.get(
              createMountedRootIdentityKey(target.handle, rootIdByPath)
            ) ?? null,
        })
      );
      const syncableTargets = resolvedTargets.filter(hasResolvedDbRootId);
      service.reconcileMountedRoots(
        managedCollectionId,
        resolvedMountedRoots.map(({ adapterRootId, dbRootId, rootPath }) => ({
          adapterRootId,
          dbRootId,
          rootPath,
        }))
      );
      const orderedTargets = await loadOrderedSyncTargets({
        backgroundDb,
        managedCollectionId,
        syncableTargets,
      });
      if (!context.isCurrent()) {
        return [];
      }
      publishNoSyncableTargetStatus({
        collectionId: managedCollectionId,
        deferredRootPaths: workspaceSelection.deferredRootPaths,
        excludedRootPaths: workspaceSelection.excludedRootPaths,
        mountedSyncableTargetCount: workspaceSelection.targets.length,
        orderedTargets,
        resolvedTargets,
        setStatus: setSyncStatus,
      });

      return orderedTargets.map((target, targetIndex) => ({
        adapterRootId: target.adapterRootId,
        backfillMode:
          targetIndex === orderedTargets.length - 1 ? ('enqueue' as const) : ('defer' as const),
        dbRootId: target.dbRootId,
        enabled,
        indexingPolicyPreset,
        managedCollectionId,
        rootDirectoryHandle: target.handle,
        scope:
          target.scope.mode === 'paths'
            ? { changes: target.scope.changes ?? [], mode: 'paths' as const }
            : { mode: 'full' as const },
      }));
    },
    [
      backgroundDb,
      dbRootIdByAdapterRootId,
      dbRootKindByAdapterRootId,
      enabled,
      indexingPolicyPreset,
      managedCollectionId,
      resolveDbRootId,
      rootSetKey,
      rootsReconciliationSettled,
      service,
      setSyncStatus,
      worktreeRootIndexingOptInById,
    ]
  );

  useEffect(() => {
    indexingCoordinator.updateInputs({
      enabled,
      hasHydrated,
      indexingPolicyPreset,
      isAccessLoading,
      onBootstrap: triggerWorkspaceIndexBootstrap,
      onError: reportAsyncError,
      // The web producer indexes into its collection and waits for one to exist.
      partition: { kind: 'collection', managedCollectionId },
      publishPaused: ({
        activeRootPath,
        managedCollectionId: collectionId,
        pauseReasons: reasons,
      }) => {
        setSyncStatus({
          activeRootPath,
          currentFilePath: null,
          lastError: null,
          managedCollectionId: collectionId,
          managedCollectionName: null,
          pauseReasons: [...reasons],
          state: 'paused',
        });
      },
      publishRuntimeUnavailable: ({
        activeRootPath,
        enabled: indexingEnabled,
        managedCollectionId: collectionId,
      }) => {
        if (!indexingEnabled) {
          resetSyncStatus();
          return;
        }
        setSyncStatus({
          activeRootPath,
          currentFilePath: null,
          lastError: null,
          managedCollectionId: collectionId,
          managedCollectionName: null,
          processedFiles: 0,
          queuedFiles: 0,
          state: 'waiting',
        });
      },
      publishWaiting: ({ activeRootPath, managedCollectionId: collectionId }) => {
        setSyncStatus({
          activeRootPath,
          currentFilePath: null,
          lastError: null,
          managedCollectionId: collectionId,
          managedCollectionName: null,
          processedFiles: 0,
          queuedFiles: 0,
          state: 'waiting',
        });
      },
      readPaused: () => getBackgroundWorkArbiterSnapshot().backgroundIndexingPaused,
      readPauseReasons: () => {
        const snapshot = getBackgroundWorkArbiterSnapshot();
        if (!snapshot.backgroundIndexingPaused) {
          return [];
        }
        return [
          ...(snapshot.manualPause ? ['Paused manually'] : []),
          ...getBackgroundWorkPauseReasonLabels(snapshot.automaticPauseReasons),
        ];
      },
      readRootDirectoryHandle: () => rootDirectoryHandleRef.current,
      resolveTargets: resolveSyncTargets,
      service,
    });
    indexingCoordinator.trigger({ mode: 'full' }, { restartActive: true });
  }, [
    enabled,
    hasHydrated,
    indexingCoordinator,
    indexingPolicyPreset,
    isAccessLoading,
    managedCollectionId,
    reportAsyncError,
    resetSyncStatus,
    resolveSyncTargets,
    service,
    setSyncStatus,
    triggerWorkspaceIndexBootstrap,
  ]);

  const triggerSync = useCallback(
    (scope: TriggerSyncScope = { mode: 'full' }, options: TriggerSyncOptions = {}) => {
      indexingCoordinator.trigger(scope, options);
    },
    [indexingCoordinator]
  );
  const triggerSyncFromEvent = useEffectEvent(triggerSync);

  // Re-run the sync when background-work state changes (pause -> cancel + paused
  // status; resume -> sync). This replaces the old backgroundWorkSnapshot
  // triggerSync dependency: re-triggering via triggerSyncFromEvent does NOT run
  // the owning effect's service.cancel() cleanup, so benign churn no longer
  // aborts an in-flight sync (only the in-handler pause guard cancels, which is
  // correct). Subscribed once; triggerSyncFromEvent is identity-stable.
  useEffect(
    () =>
      subscribeToBackgroundWorkArbiter(() => {
        triggerSyncFromEvent();
      }),
    []
  );

  useEffect(() => {
    // Live reads (not deps): focus-only changes must not re-run this effect —
    // its immediate audit can fire a recovery sync (BST-1268, see rootSetKey).
    const rootDirectoryHandle = rootDirectoryHandleRef.current;
    const rootDirectoryHandles = rootDirectoryHandlesRef.current;
    const rootIdByPath = rootIdByPathRef.current;
    let disposed = false;
    let activeAuditToken: symbol | null = null;
    let inFlightAuditKey: string | null = null;
    let recoveryAttemptedAuditKey: string | null = null;
    let verifiedAuditKey: string | null = null;

    const maybeAuditIdleCoverage = (
      status: ReturnType<typeof useWorkspaceCollectionSyncStatusStore.getState>
    ): void => {
      if (status.state !== 'idle') {
        if (status.state !== 'waiting') {
          activeAuditToken = null;
          inFlightAuditKey = null;
          verifiedAuditKey = null;
        }
        return;
      }
      const collectionId = status.managedCollectionId ?? managedCollectionId;
      if (!(enabled && collectionId && backgroundDb && fileSystemAdapter)) {
        return;
      }
      const handles = getActiveRootHandles({ rootDirectoryHandle, rootDirectoryHandles });
      if (handles.length === 0) {
        return;
      }

      const auditKey = createCoverageAuditKey({
        collectionId,
        handles,
        policyPreset: indexingPolicyPreset,
        rootIdByPath,
      });
      if (verifiedAuditKey === auditKey || inFlightAuditKey === auditKey) {
        return;
      }

      const auditToken = Symbol('workspace-coverage-audit');
      activeAuditToken = auditToken;
      inFlightAuditKey = auditKey;
      const activeRootPath = rootDirectoryHandle?.path ?? handles[0]?.path ?? null;
      setSyncStatus(
        createCoverageStatusPatch({
          activeRootPath,
          collectionId,
          lastError: WORKSPACE_COVERAGE_AUDIT_MESSAGE,
          state: 'waiting',
        })
      );

      void startWorkspaceCoverageAudit({
        activeRootPath,
        auditKey,
        clearInFlightAudit: (completedAuditKey) => {
          if (!(disposed || inFlightAuditKey !== completedAuditKey)) {
            inFlightAuditKey = null;
          }
        },
        collectionId,
        db: backgroundDb,
        fileSystemAdapter,
        handles,
        isCurrent: () => !disposed && activeAuditToken === auditToken,
        markAuditVerified: (verifiedKey) => {
          if (!disposed) {
            verifiedAuditKey = verifiedKey;
            recoveryAttemptedAuditKey = null;
          }
        },
        policyPreset: indexingPolicyPreset,
        resolveDbRootId,
        rootIdByPath,
        setStatus: setSyncStatus,
      }).then((recoveryAttemptKey) => {
        if (!disposed && recoveryAttemptKey) {
          if (recoveryAttemptedAuditKey === recoveryAttemptKey) {
            return;
          }
          // One automatic recovery is allowed for each observed incomplete
          // outcome. If that sync is interrupted, identical mismatches remain
          // suppressed, but changed indexed/expected counts produce a new key.
          recoveryAttemptedAuditKey = recoveryAttemptKey;
          triggerSyncFromEvent({ mode: 'full' });
        }
      });
    };

    maybeAuditIdleCoverage(useWorkspaceCollectionSyncStatusStore.getState());
    const unsubscribe = useWorkspaceCollectionSyncStatusStore.subscribe(maybeAuditIdleCoverage);
    return () => {
      disposed = true;
      unsubscribe();
    };
    // BST-1268: rootSetKey deliberately replaces the focused handle, handles
    // array, and path map identities so focus-only changes do not recreate this
    // coverage subscription or fire its immediate recovery audit.
  }, [
    backgroundDb,
    enabled,
    fileSystemAdapter,
    indexingPolicyPreset,
    managedCollectionId,
    resolveDbRootId,
    rootSetKey,
    setSyncStatus,
  ]);

  const readDatabaseSchedulerSnapshot = useCallback(async (): Promise<unknown> => {
    if (backgroundDb) {
      const scheduler = getDatabaseWorkScheduler(backgroundDb);
      if (scheduler) {
        return scheduler.getSnapshot();
      }
    }
    const schedulerSnapshot = getDesktopDatabaseBridge()?.schedulerSnapshot;
    return schedulerSnapshot ? await schedulerSnapshot() : null;
  }, [backgroundDb]);

  const countExpectedDebugRoots = useCallback(async () => {
    const handles =
      rootDirectoryHandles.length > 0
        ? rootDirectoryHandles
        : rootDirectoryHandle
          ? [rootDirectoryHandle]
          : [];
    const results = await Promise.all(
      handles.map((handle) =>
        countExpectedWorkspaceIndexFiles({
          fileSystemAdapter,
          policyPreset: indexingPolicyPreset,
          rootHandle: handle,
        })
      )
    );
    // The debug surface serializes into snapshots; raw file nodes carry live
    // fs handles and would bloat/break that, so expose paths only.
    return results.map(({ fileNodes: _fileNodes, ...serializable }) => serializable);
  }, [fileSystemAdapter, indexingPolicyPreset, rootDirectoryHandle, rootDirectoryHandles]);

  const readDebugHostStatus = useCallback(async (bridgeName: 'chunkingHost' | 'embeddingHost') => {
    const bridge: unknown = Reflect.get(window, bridgeName);
    if (
      !bridge ||
      typeof bridge !== 'object' ||
      !('getStatus' in bridge) ||
      typeof bridge.getStatus !== 'function'
    ) {
      return {
        available: false,
        reason: `${bridgeName} bridge unavailable`,
      };
    }
    try {
      const status: unknown = await bridge.getStatus();
      return {
        available: true,
        status,
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }, []);

  const readDebugSnapshot = useCallback(async (): Promise<WorkspaceIndexDebugSnapshot> => {
    const accessIssues: Array<{ reason: string; source: string }> = [];
    const electronQuery = getDesktopDatabaseBridge()?.query;
    const query =
      typeof electronQuery === 'function'
        ? (((sql: string, params?: unknown[]) =>
            electronQuery(sql, params, BACKGROUND_DATABASE_WORK_OPTIONS) as Promise<{
              rows?: unknown[];
            }>) satisfies WorkspaceIndexDebugDbQuery)
        : (backgroundDb?.query as WorkspaceIndexDebugDbQuery | undefined);
    const [
      expectedCounts,
      roots,
      fileRecordsByRoot,
      chunkedRecordsByRoot,
      chunkStatsByRoot,
      chunkStatsByRootAndSet,
      jobQueue,
      jobQueueReadiness,
      recentEmbeddingCompletions,
      recentEmbeddingFailures,
      databaseScheduler,
      chunkingHostStatus,
      embeddingHostStatus,
    ] = await Promise.all([
      countExpectedDebugRoots(),
      readWorkspaceIndexDebugRows(
        query,
        'SELECT id, path, display_name, kind, status, created_at, last_verified_at FROM roots ORDER BY created_at ASC',
        [],
        accessIssues,
        'roots'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT root_id, COUNT(*)::int AS file_count,
                COUNT(*) FILTER (WHERE chunks_processed_at IS NOT NULL)::int AS chunked_file_count,
                COUNT(*) FILTER (WHERE chunks_processed_at IS NULL)::int AS unchunked_file_count
           FROM file_records
          WHERE ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY root_id
          ORDER BY root_id`,
        [managedCollectionId],
        accessIssues,
        'file_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* chunked_records_by_root_query_marker */
         SELECT fr.root_id,
                fr.id,
                fr.path AS relative_path,
                fr.chunks_processed_at,
                COUNT(fc.id)::int AS chunk_count
           FROM file_records fr
           LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
          WHERE ($1::text IS NULL OR fr.embedding_set_id = $1::text)
            AND fr.chunks_processed_at IS NOT NULL
          GROUP BY fr.root_id, fr.id, fr.path, fr.chunks_processed_at
          ORDER BY fr.root_id, fr.path`,
        [managedCollectionId],
        accessIssues,
        'chunked_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT fr.root_id,
                COUNT(fc.id)::int AS chunk_count,
                COUNT(fc.embedding)::int AS embedded_chunk_count,
                COUNT(*) FILTER (WHERE fc.embedding IS NULL)::int AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ($1::text IS NULL OR fc.embedding_set_id = $1::text)
          GROUP BY fr.root_id
          ORDER BY fr.root_id`,
        [managedCollectionId],
        accessIssues,
        'chunks_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* chunks_by_root_and_set_query_marker */
         SELECT fr.root_id,
                fc.embedding_set_id,
                COUNT(fc.id)::int AS chunk_count,
                COUNT(fc.embedding)::int AS embedded_chunk_count,
                COUNT(*) FILTER (WHERE fc.embedding IS NULL)::int AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ($1::text IS NULL OR fr.embedding_set_id = $1::text)
          GROUP BY fr.root_id, fc.embedding_set_id
          ORDER BY fr.root_id, fc.embedding_set_id`,
        [managedCollectionId],
        accessIssues,
        'chunks_by_root_and_set'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT queue, job_type, state, COUNT(*)::int AS count,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY queue, job_type, state
          ORDER BY queue, job_type, state`,
        [managedCollectionId],
        accessIssues,
        'job_queue'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* job_queue_readiness_query_marker */
         SELECT state,
                COUNT(*) FILTER (WHERE run_at <= $2::text)::int AS due_count,
                COUNT(*) FILTER (WHERE run_at > $2::text)::int AS future_count,
                MIN(run_at) AS oldest_run_at,
                MAX(run_at) AS newest_run_at,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY state
          ORDER BY state`,
        [managedCollectionId, new Date().toISOString()],
        accessIssues,
        'job_queue_readiness'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `SELECT id, state, worker_id, attempts, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'succeeded'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          ORDER BY updated_at DESC
          LIMIT 10`,
        [managedCollectionId],
        accessIssues,
        'recent_embedding_completions'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* recent_embedding_failures_query_marker */
         SELECT id, state, worker_id, attempts, max_attempts, run_at, leased_until, error, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'failed'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          ORDER BY updated_at DESC
          LIMIT 20`,
        [managedCollectionId],
        accessIssues,
        'recent_embedding_failures'
      ),
      readDatabaseSchedulerSnapshot(),
      readDebugHostStatus('chunkingHost'),
      readDebugHostStatus('embeddingHost'),
    ]);
    const debugSyncHandles = getActiveRootHandles({ rootDirectoryHandle, rootDirectoryHandles });
    const syncTargets = await Promise.all(
      debugSyncHandles.map(async (handle) => {
        const adapterRootId = handle.rootId ?? rootIdByPath.get(handle.path) ?? null;
        const dbRootId = await resolveDbRootId(handle.path, adapterRootId);
        return {
          adapterRootId,
          dbRootId,
          name: handle.name,
          path: handle.path,
        };
      })
    );

    return {
      ...(accessIssues.length > 0 ? { accessIssues } : {}),
      backgroundEffectiveHasHydrated: hasHydrated,
      backgroundPersistHasHydrated: readBackgroundIndexingPreferencesPersistHydrated(),
      backgroundPreferences: useBackgroundIndexingPreferencesStore.getState(),
      chunkedRecordsByRoot,
      chunkingHostStatus,
      chunkStatsByRoot,
      chunkStatsByRootAndSet,
      databaseScheduler,
      embeddingHostStatus: {
        ...((embeddingHostStatus && typeof embeddingHostStatus === 'object'
          ? embeddingHostStatus
          : {}) as Record<string, unknown>),
        recentEmbeddingCompletions,
      },
      expectedCounts,
      fileRecordsByRoot,
      jobQueue,
      jobQueueReadiness,
      managedCollectionId,
      memorySample: readWorkspaceIndexMemorySample(),
      recentEmbeddingFailures,
      roots,
      runtimeReadiness: {
        message: service ? null : createRuntimeUnavailableMessage(missingRuntimeDependencies),
        missingDependencies: missingRuntimeDependencies,
        serviceAvailable: Boolean(service),
      },
      selectedDevicePreference,
      syncLoop: {
        ...syncLoopDebugRef.current,
        ...indexingCoordinator.getDebugState(),
      },
      syncReadiness: {
        enabled,
        hasHydrated,
        hasManagedCollectionId: Boolean(managedCollectionId),
        hasRootDirectoryHandle: Boolean(rootDirectoryHandle),
        isAccessLoading,
        rootDirectoryHandlePath: rootDirectoryHandle?.path ?? null,
        rootDirectoryHandles: rootDirectoryHandles.map((handle) => ({
          path: handle.path,
          rootId: handle.rootId ?? rootIdByPath.get(handle.path) ?? null,
        })),
        rootsReconciliationSettled,
        serviceAvailable: Boolean(service),
      },
      syncStatus: useWorkspaceCollectionSyncStatusStore.getState(),
      syncTargets,
    };
  }, [
    backgroundDb,
    countExpectedDebugRoots,
    enabled,
    hasHydrated,
    isAccessLoading,
    managedCollectionId,
    missingRuntimeDependencies,
    readDatabaseSchedulerSnapshot,
    rootsReconciliationSettled,
    readDebugHostStatus,
    resolveDbRootId,
    rootDirectoryHandle,
    rootDirectoryHandles,
    rootIdByPath,
    selectedDevicePreference,
    service,
    indexingCoordinator,
  ]);

  const readDebugSummary = useCallback(async (): Promise<WorkspaceIndexDebugSummary> => {
    const accessIssues: Array<{ reason: string; source: string }> = [];
    const electronQuery = getDesktopDatabaseBridge()?.query;
    const query =
      typeof electronQuery === 'function'
        ? (((sql: string, params?: unknown[]) =>
            electronQuery(sql, params, BACKGROUND_DATABASE_WORK_OPTIONS) as Promise<{
              rows?: unknown[];
            }>) satisfies WorkspaceIndexDebugDbQuery)
        : (backgroundDb?.query as WorkspaceIndexDebugDbQuery | undefined);
    const [
      roots,
      fileRecordsByRoot,
      chunkStatsByRootAndSet,
      jobQueue,
      jobQueueReadiness,
      recentEmbeddingFailures,
      databaseScheduler,
      embeddingHostStatus,
    ] = await Promise.all([
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_roots_marker */
         SELECT id, path, display_name, kind, status, created_at, last_verified_at
           FROM roots
          ORDER BY created_at ASC`,
        [],
        accessIssues,
        'summary_roots'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_file_records_marker */
         SELECT root_id, COUNT(*)::int AS file_count,
                COUNT(*) FILTER (WHERE chunks_processed_at IS NOT NULL)::int AS chunked_file_count,
                COUNT(*) FILTER (WHERE chunks_processed_at IS NULL)::int AS unchunked_file_count
           FROM file_records
          WHERE ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY root_id
          ORDER BY root_id`,
        [managedCollectionId],
        accessIssues,
        'summary_file_records_by_root'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_chunks_marker */
         SELECT fr.root_id,
                fc.embedding_set_id,
                COUNT(fc.id)::int AS chunk_count,
                COUNT(fc.embedding)::int AS embedded_chunk_count,
                COUNT(*) FILTER (WHERE fc.embedding IS NULL)::int AS pending_chunk_count
           FROM file_chunks fc
           JOIN file_records fr ON fr.id = fc.file_record_id
          WHERE ($1::text IS NULL OR fr.embedding_set_id = $1::text)
          GROUP BY fr.root_id, fc.embedding_set_id
          ORDER BY fr.root_id, fc.embedding_set_id`,
        [managedCollectionId],
        accessIssues,
        'summary_chunks_by_root_and_set'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_job_queue_marker */
         SELECT queue, job_type, state, COUNT(*)::int AS count,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY queue, job_type, state
          ORDER BY queue, job_type, state`,
        [managedCollectionId],
        accessIssues,
        'summary_job_queue'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_job_queue_readiness_marker */
         SELECT state,
                COUNT(*) FILTER (WHERE run_at <= $2::text)::int AS due_count,
                COUNT(*) FILTER (WHERE run_at > $2::text)::int AS future_count,
                MIN(run_at) AS oldest_run_at,
                MAX(run_at) AS newest_run_at,
                MIN(updated_at) AS oldest_updated_at,
                MAX(updated_at) AS newest_updated_at
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          GROUP BY state
          ORDER BY state`,
        [managedCollectionId, new Date().toISOString()],
        accessIssues,
        'summary_job_queue_readiness'
      ),
      readWorkspaceIndexDebugRows(
        query,
        `/* workspace_index_summary_recent_embedding_failures_marker */
         SELECT id, state, worker_id, attempts, max_attempts, run_at, leased_until, error, updated_at, payload
           FROM job_queue
          WHERE job_type = 'embed_chunk'
            AND state = 'failed'
            AND ($1::text IS NULL OR embedding_set_id = $1::text)
          ORDER BY updated_at DESC
          LIMIT 20`,
        [managedCollectionId],
        accessIssues,
        'summary_recent_embedding_failures'
      ),
      readDatabaseSchedulerSnapshot(),
      readDebugHostStatus('embeddingHost'),
    ]);

    return {
      ...(accessIssues.length > 0 ? { accessIssues } : {}),
      backgroundPreferences: useBackgroundIndexingPreferencesStore.getState(),
      chunkStatsByRootAndSet,
      databaseScheduler,
      embeddingHostStatus,
      fileRecordsByRoot,
      jobQueue,
      jobQueueReadiness,
      managedCollectionId,
      memorySample: readWorkspaceIndexMemorySample(),
      recentEmbeddingFailures,
      roots,
      selectedDevicePreference,
      syncStatus: useWorkspaceCollectionSyncStatusStore.getState(),
    };
  }, [
    backgroundDb,
    managedCollectionId,
    readDatabaseSchedulerSnapshot,
    readDebugHostStatus,
    selectedDevicePreference,
  ]);

  const benchmarkDebugStage: WorkspaceIndexDebugApi['benchmarkStage'] = useCallback(
    async (request) => {
      const electronRunTransaction = getDesktopDatabaseBridge()?.runTransaction;
      const chunkingHost =
        typeof window === 'undefined'
          ? undefined
          : (
              window as Window & {
                chunkingHost?: {
                  chunkBatch?: (request: {
                    files: readonly {
                      content: string;
                      fileName: string;
                      filePath: string;
                      fileRecordId: string;
                    }[];
                    kind: 'chunk-batch';
                    options: {
                      allowLargeFiles: boolean;
                      forceStrategy: boolean;
                      ignoreFileTypeRecommendations: boolean;
                      maxTokens: number;
                      overlap: number;
                      requestedStrategy: 'recursive';
                      tokenTrueSizing: boolean;
                    };
                    requestId: string;
                  }) => Promise<readonly unknown[]>;
                };
              }
            ).chunkingHost;
      const embeddingHost =
        typeof window === 'undefined'
          ? undefined
          : (
              window as Window & {
                embeddingHost?: {
                  getStatus?: () => Promise<unknown>;
                  queryEmbedding?: (payload: {
                    dimensions: number;
                    modelId: string;
                    modelKey: string;
                    query: string;
                  }) => Promise<readonly number[]>;
                };
              }
            ).embeddingHost;
      const applyManagedCacheBatch = async (
        args: Parameters<typeof applyManagedCacheBatchLocally>[1]
      ) => {
        const electronApplyManagedCacheBatch = getDesktopDatabaseBridge()?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        if (!backgroundDb) {
          throw new Error('Workspace Index stage benchmark requires managed-cache apply support.');
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      };
      if (request.mode === 'db-completion-ceiling' && !(backgroundDb || electronRunTransaction)) {
        throw new Error('Workspace Index stage benchmark requires transactional database support.');
      }
      return await runWorkspaceIndexStageBenchmark({
        applyManagedCacheBatch,
        chunkingHost,
        db: backgroundDb,
        electronRunTransaction,
        electronTransactionOptions: BACKGROUND_DATABASE_WORK_OPTIONS,
        embeddingHost,
        request,
      });
    },
    [backgroundDb]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const env = (
      import.meta as ImportMeta & {
        env?: Record<string, unknown>;
      }
    ).env;
    if (!shouldExposeWorkspaceIndexDebugApi(env)) {
      window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = undefined;
      return;
    }
    const workspaceIndexDebugApi = Object.freeze<WorkspaceIndexDebugApi>({
      benchmarkStage: benchmarkDebugStage,
      configure: ({ policyPreset }) => {
        if (policyPreset) {
          setIndexingPolicyPreset(policyPreset);
        }
      },
      countExpected: countExpectedDebugRoots,
      snapshot: readDebugSnapshot,
      summary: readDebugSummary,
      triggerFullSync: () => {
        triggerSync({ mode: 'full' });
      },
    });
    window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = workspaceIndexDebugApi;
    return () => {
      if (window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === workspaceIndexDebugApi) {
        window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = undefined;
      }
    };
  }, [
    benchmarkDebugStage,
    countExpectedDebugRoots,
    readDebugSnapshot,
    readDebugSummary,
    setIndexingPolicyPreset,
    triggerSync,
  ]);

  useEffect(() => {
    setBackgroundWorkManualPause(paused);
    return () => {
      setBackgroundWorkManualPause(false);
    };
  }, [paused]);

  useEffect(() => {
    if (!service) {
      return;
    }
    return registerBackgroundWorkPauseHandler('background-indexing', {
      pause: () => indexingCoordinator.cancel(),
    });
  }, [indexingCoordinator, service]);

  // Teardown detaches, it does not cancel (BST-1654). This cleanup runs on
  // unmount AND on every `service` identity change, so cancelling here tied the
  // lifetime of a host-owned `source: 'background-indexing'` run to a React
  // memo dependency list. The renderer-side loop still stops; the durable
  // backfill survives and the next sync re-attaches to it.
  useEffect(
    () => () => {
      void indexingCoordinator.detach(service).catch((error) => {
        reportAsyncError('detach', error);
      });
    },
    [indexingCoordinator, reportAsyncError, service]
  );

  useEffect(() => {
    const handleRefresh = (event: Event): void => {
      const scope = parseRefreshSyncScope(event);
      if (scope === null) {
        return;
      }
      triggerSyncFromEvent(scope);
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    };
  }, []);

  useEffect(
    () =>
      onQueueDrained((detail) => {
        if (
          detail?.queue !== 'embeddings' ||
          typeof detail.embeddingSetId !== 'string' ||
          detail.embeddingSetId !== managedCollectionId
        ) {
          return;
        }
        triggerSyncFromEvent({ mode: 'full' });
      }),
    [managedCollectionId]
  );

  // Recovery point for renderer-side work lost while the window was hidden (a
  // hard reload tearing down the page mid-run): re-sync on return to visibility
  // so the 0-changes coverage check can re-enqueue any missing embedding work.
  // An ordinary unmount detaches instead of cancelling (BST-1654), so this is
  // no longer the only thing standing between a user and a dead backfill.
  useResyncOnReturnToVisibility(triggerSync);

  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
