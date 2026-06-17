import {
  applyManagedCacheBatch as applyManagedCacheBatchLocally,
  createDatabasePressureController,
  createPriorityDbHandle,
  type DatabaseWorkSchedulerSnapshot,
  type DbHandle,
  ElectronEmbeddingSetsRepository,
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  getDatabasePressureWaitingReason,
  getDatabaseWorkScheduler,
  invalidateManagedCacheEntriesByIdentity as invalidateManagedCacheEntriesByIdentityLocally,
  usePGliteDatabase,
} from '@brainstrike/db';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEventDetail,
  useFileSystem,
} from '@brainstrike/file-explorer-ui/shell';
import { useOptionalFileTreeContext } from '@brainstrike/file-explorer-ui/tree';
import { useChunkingWorkerContext } from '@brainstrike/file-import/chunking-worker-context';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import {
  useWorkspaceCollectionSyncStatusStore,
  type WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type { DirectoryHandle, FileSystemChange } from '@brainstrike/types';
import {
  getBackgroundWorkArbiterSnapshot,
  getBackgroundWorkPauseReasonLabels,
  registerBackgroundWorkPauseHandler,
  setBackgroundWorkManualPause,
  subscribeToBackgroundWorkArbiter,
} from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import {
  assertValidWorkspaceIndexingPowerSnapshot,
  type WorkspaceIndexingPowerSnapshot,
} from '@brainstrike/utils/workspace-indexing-power-snapshot';
import {
  createWorkspaceIndexingQosTransitionLogger,
  resolveWorkspaceIndexingQosPolicy,
  type WorkspaceIndexingDatabasePressure,
  type WorkspaceIndexingQosPolicy,
} from '@brainstrike/utils/workspace-indexing-qos';
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
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import { useResyncOnReturnToVisibility } from './use-resync-on-return-to-visibility';
import { WorkspaceCollectionSyncService } from './workspace-collection-sync-service';
import {
  isWorkspaceIndexBlockedError,
  WorkspaceIndexBlockedError,
} from './workspace-index-blocked-error';
import { bootstrapWorkspaceIndexCollection } from './workspace-index-bootstrap-service';
import {
  countExpectedWorkspaceIndexFiles,
  readWorkspaceIndexDebugRows,
  readWorkspaceIndexMemorySample,
  shouldExposeWorkspaceIndexDebugApi,
  type WorkspaceIndexDebugApi,
  type WorkspaceIndexDebugDbQuery,
  type WorkspaceIndexDebugSnapshot,
} from './workspace-index-debug-harness';

const logger = createLogger('WorkspaceCollectionSyncProvider');

export { FILE_EXPLORER_REFRESH_EVENT };

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
const QUEUE_DRAINED_EVENT = 'brainstrike:queue-drained' as const;

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
    currentFilePath: null,
    scanSummary: null,
    importProgress: null,
    chunkingProgress: null,
    embeddingProgress: null,
    queueProgress: null,
    queuedFiles: 0,
    processedFiles: 0,
    lastError: null,
    pauseReasons: [],
  };
}

interface WorkspaceIndexingPowerBridge {
  getSnapshot?: () => Promise<WorkspaceIndexingPowerSnapshot>;
}

type TriggerSyncScope =
  | {
      mode: 'full';
    }
  | {
      mode: 'paths';
      roots: Array<{
        changes: readonly FileSystemChange[];
        rootId: string;
      }>;
    };

interface SyncLoopTarget {
  handle: DirectoryHandle;
  scope: {
    changes?: readonly FileSystemChange[];
    mode: 'full' | 'paths';
  };
}

function buildFullSyncTargets(handles: readonly DirectoryHandle[]): SyncLoopTarget[] {
  return handles.map((handle) => ({
    handle,
    scope: { mode: 'full' },
  }));
}

export interface WorkspaceCollectionSyncProviderProps {
  children: ReactNode;
}

function createBackgroundRepositoryDb(db: DbHandle): {
  exec: (sql: string) => Promise<void>;
  insertChunksAndEnqueueEmbeddingJobs?: DbHandle['insertChunksAndEnqueueEmbeddingJobs'];
  query: DbHandle['query'];
} {
  if (!db.exec) {
    throw new Error('Background indexing requires database exec support.');
  }
  const handle: {
    exec: (sql: string) => Promise<void>;
    insertChunksAndEnqueueEmbeddingJobs?: DbHandle['insertChunksAndEnqueueEmbeddingJobs'];
    query: DbHandle['query'];
  } = {
    query: db.query,
    exec: async (sql: string) => {
      await db.exec?.(sql);
    },
  };
  if (db.insertChunksAndEnqueueEmbeddingJobs) {
    handle.insertChunksAndEnqueueEmbeddingJobs = db.insertChunksAndEnqueueEmbeddingJobs.bind(db);
  }
  return handle;
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
    return (
      typeof rootCandidate['rootId'] === 'string' &&
      rootCandidate['rootId'].length > 0 &&
      typeof rootCandidate['rootPath'] === 'string' &&
      Array.isArray(rootCandidate['changes']) &&
      rootCandidate['changes'].every(isFileSystemChange)
    );
  });
}

function parseRefreshSyncScope(event: Event): TriggerSyncScope {
  if (!(event instanceof CustomEvent)) {
    return { mode: 'full' };
  }
  if (!isWorkspaceRefreshDetail(event.detail)) {
    return { mode: 'full' };
  }
  if (!(event.detail.source === 'watcher' && event.detail.scope === 'incremental')) {
    return { mode: 'full' };
  }
  if (event.detail.roots.length === 0) {
    return { mode: 'full' };
  }
  return {
    mode: 'paths',
    roots: event.detail.roots.map((root) => ({
      rootId: root.rootId,
      changes: root.changes,
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
      scope: { mode: 'paths', changes: [] },
    });
  }
  for (const root of args.scope.roots) {
    const target = targetByRootId.get(root.rootId);
    if (!target) {
      continue;
    }
    const existingChanges = target.scope.changes ?? [];
    targetByRootId.set(root.rootId, {
      handle: target.handle,
      scope: {
        mode: 'paths',
        changes: [...existingChanges, ...root.changes],
      },
    });
  }
  return [...targetByRootId.values()].filter(
    (target) => target.scope.mode === 'paths' && (target.scope.changes?.length ?? 0) > 0
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

function createWaitForBackgroundPermit(
  db: DbHandle
): (options: { readonly label: string }) => Promise<void> {
  const scheduler = getDatabaseWorkScheduler(db);
  if (scheduler) {
    return createDatabasePressureController({ scheduler }).waitForBackgroundPermit;
  }

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Background indexing requires database QoS scheduler snapshots.');
  }

  return createDatabasePressureController({
    pollMs: BACKGROUND_PRESSURE_POLL_MS,
    snapshotSource: {
      getSnapshot: schedulerSnapshot,
    },
  }).waitForBackgroundPermit;
}

function toWorkspaceIndexingDatabasePressure(
  snapshot: DatabaseWorkSchedulerSnapshot
): WorkspaceIndexingDatabasePressure {
  const waitingReason = getDatabasePressureWaitingReason(snapshot, snapshot.snapshotAt);
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

  const schedulerSnapshot =
    typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
  if (!schedulerSnapshot) {
    throw new Error('Workspace Index QoS requires database scheduler snapshots.');
  }

  return async () => toWorkspaceIndexingDatabasePressure(await schedulerSnapshot());
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
}: WorkspaceCollectionSyncProviderProps) {
  const { fileSystemAdapter } = useAdapters();
  const { isAccessLoading, rootDirectoryHandle, rootDirectoryHandles, rootIdByPath } =
    useFileSystem();
  const fileTreeContext = useOptionalFileTreeContext();
  const db = usePGliteDatabase();

  // Root registry: ensure a DB roots row exists for every adapter root.
  // Runs once per boot, before the first sync cycle writes file records.
  // Errors are logged and swallowed — must never block boot.
  // The returned callbacks are ref-stable: identity does not change when the
  // reconciliation map resolves, so the service useMemo is not reconstructed.
  const { registerRoot, resolveDbRootId } = useRootsReconciliation({
    adapter: fileSystemAdapter,
    db,
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
  const readPowerSnapshot = useMemo(() => createReadPowerSnapshot(), []);
  const backgroundRepositories = useMemo(() => {
    if (!backgroundDb) {
      return null;
    }
    const repositoryDb = createBackgroundRepositoryDb(backgroundDb);
    return {
      chunkRepository: new ElectronFileChunkRepository(repositoryDb),
      embeddingSetsRepository: new ElectronEmbeddingSetsRepository(repositoryDb),
      fileRecordRepository: new ElectronFileRecordRepository(repositoryDb),
    };
  }, [backgroundDb]);
  const { ensureStarted: ensureChunkingWorker } = useChunkingWorkerContext();
  const enabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const hasHydrated = useBackgroundIndexingPreferencesStore((state) => state.hasHydrated);
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
  const setSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.setStatus);
  const resetSyncStatus = useWorkspaceCollectionSyncStatusStore((state) => state.reset);
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
  // Stale-loop guard for sequential multi-root sync: incremented each time
  // triggerSync fires so that an older loop can detect it is superseded and
  // stop iterating before feeding more roots to service.sync.
  const syncLoopGenerationRef = useRef(0);
  const backgroundWorkSnapshot = useSyncExternalStore(
    subscribeToBackgroundWorkArbiter,
    getBackgroundWorkArbiterSnapshot,
    getBackgroundWorkArbiterSnapshot
  );

  const reportAsyncError = useCallback(
    (operation: string, error: unknown): void => {
      logger.error(`Workspace collection sync ${operation} failed`, { error });
      if (isWorkspaceIndexBlockedError(error)) {
        setSyncStatus({
          state: 'blocked',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          ...createClearedProgressPatch(),
          blockedReason: error.blockedReason,
          lastError: error.message,
        });
        return;
      }
      setSyncStatus({
        state: 'error',
        blockedReason: null,
        managedCollectionId,
        managedCollectionName: null,
        activeRootPath: rootDirectoryHandle?.path ?? null,
        currentFilePath: null,
        queuedFiles: 0,
        processedFiles: 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    },
    [managedCollectionId, rootDirectoryHandle?.path, setSyncStatus]
  );
  const isTreeRestorationReady =
    fileTreeContext === null ||
    (!(fileTreeContext.isLoading || fileTreeContext.isRestoringExpandedPaths) &&
      fileTreeContext.isRestorationSettled);

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

  // useState lazy initializer guarantees one transition tracker per provider
  // instance: the sync loop re-resolves the QoS policy every cycle, and the
  // tracker logs only (state, reason) transitions instead of every resolution.
  const [observeQosTransition] = useState(() =>
    createWorkspaceIndexingQosTransitionLogger('app-shell-sync')
  );

  const resolveQosPolicy = useCallback(async (): Promise<WorkspaceIndexingQosPolicy> => {
    if (!readDatabasePressure) {
      throw new Error('Workspace Index QoS requires database scheduler snapshots.');
    }
    const powerSnapshot = readPowerSnapshot ? await readPowerSnapshot() : null;
    const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
    const policy = resolveWorkspaceIndexingQosPolicy({
      dbPressure: await readDatabasePressure(),
      // Coarse app-shell signal: this spans the full assistant turn so background
      // indexing yields while tool/LLM work is active. The desktop hidden-host
      // ForegroundEmbeddingGate remains the embedding-scoped GPU coordination path.
      foregroundQueryActive: getAssistantForegroundActivitySnapshot(),
      idleState: powerSnapshot?.idleState ?? 'unknown',
      idleTimeMs: powerSnapshot?.idleTimeMs ?? null,
      manualPaused: latestBackgroundWorkSnapshot.backgroundIndexingPaused,
      powerSource: powerSnapshot?.powerSource ?? 'unknown',
      // TODO(workspace-index-qos): wire hosted provider rate-limit telemetry when
      // backfill exposes provider throttling as durable state.
      providerRateLimited: false,
      recentUserInputMs: readRecentUserInputMs(),
      thermalState: powerSnapshot?.thermalState ?? 'unknown',
      windowVisible: windowVisibleRef.current,
    });
    observeQosTransition(policy);
    return policy;
  }, [observeQosTransition, readDatabasePressure, readPowerSnapshot, readRecentUserInputMs]);

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
    return new WorkspaceCollectionSyncService({
      applyManagedCacheBatch: async (args) => {
        const electronApplyManagedCacheBatch = window.electronAPI?.db?.applyManagedCacheBatch;
        if (electronApplyManagedCacheBatch) {
          await electronApplyManagedCacheBatch(args, BACKGROUND_DATABASE_WORK_OPTIONS);
          return;
        }
        await applyManagedCacheBatchLocally(backgroundDb, args);
      },
      invalidateManagedCacheEntriesByIdentity: async (args) => {
        const electronInvalidateManagedCacheEntries =
          window.electronAPI?.db?.invalidateManagedCacheEntriesByIdentity;
        if (electronInvalidateManagedCacheEntries) {
          return await electronInvalidateManagedCacheEntries(
            args,
            BACKGROUND_DATABASE_WORK_OPTIONS
          );
        }
        return await invalidateManagedCacheEntriesByIdentityLocally(backgroundDb, args);
      },
      cancelBackfill: async (embeddingSetId) => {
        await runtimeController.cancelBackfill(embeddingSetId);
      },
      chunkRepository: backgroundRepositories.chunkRepository,
      db: backgroundDb,
      embeddingSetsRepository: backgroundRepositories.embeddingSetsRepository,
      enqueueBackfill: async (embeddingSetId, options) =>
        await runtimeController.enqueueBackfill(embeddingSetId, options),
      ensureChunkingWorker,
      ensureEmbeddingRuntimeStarted,
      fileSystemAdapter,
      fileRecordRepository: backgroundRepositories.fileRecordRepository,
      getBackfillsInFlight: async () => await runtimeController.getBackfillsInFlight(),
      log: logger,
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
    void bootstrapWorkspaceIndexCollection(
      { enabled, managedCollectionId },
      {
        embeddingSetsRepository,
        setManagedCollectionId,
      }
    )
      .then((collection) => {
        if (!collection) {
          return;
        }
        const latestBackgroundWorkSnapshot = getBackgroundWorkArbiterSnapshot();
        if (latestBackgroundWorkSnapshot.backgroundIndexingPaused) {
          setSyncStatus({
            state: 'paused',
            managedCollectionId: collection.id,
            managedCollectionName: collection.name ?? null,
            activeRootPath: rootDirectoryHandle?.path ?? null,
            currentFilePath: null,
            queuedFiles: 0,
            processedFiles: 0,
            lastError: null,
            pauseReasons: [
              ...(latestBackgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
              ...getBackgroundWorkPauseReasonLabels(
                latestBackgroundWorkSnapshot.automaticPauseReasons
              ),
            ],
          });
          return;
        }
        setSyncStatus({
          state: 'idle',
          managedCollectionId: collection.id,
          managedCollectionName: collection.name ?? null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
          pauseReasons: [],
        });
      })
      .catch((error) => {
        reportAsyncError('bootstrap', error);
      })
      .finally(() => {
        workspaceIndexBootstrapInFlightRef.current = false;
      });
    return true;
  }, [
    backgroundRepositories,
    enabled,
    managedCollectionId,
    reportAsyncError,
    rootDirectoryHandle?.path,
    setManagedCollectionId,
    setSyncStatus,
  ]);

  const triggerSync = useCallback(
    (scope: TriggerSyncScope = { mode: 'full' }) => {
      if (!hasHydrated) {
        return;
      }

      // Bump the generation so any in-flight loop from a previous triggerSync
      // call can detect that it is now stale and stop iterating.
      syncLoopGenerationRef.current += 1;

      if (!service) {
        if (enabled) {
          setSyncStatus({
            state: 'error',
            managedCollectionId,
            managedCollectionName: null,
            activeRootPath: rootDirectoryHandle?.path ?? null,
            currentFilePath: null,
            queuedFiles: 0,
            processedFiles: 0,
            lastError: 'Background indexing runtime is unavailable.',
          });
        } else {
          resetSyncStatus();
        }
        return;
      }

      if (triggerWorkspaceIndexBootstrap()) {
        return;
      }

      if (backgroundWorkSnapshot.backgroundIndexingPaused) {
        void service.cancel().catch((error) => {
          reportAsyncError('cancel', error);
        });
        setSyncStatus({
          state: 'paused',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle?.path ?? null,
          currentFilePath: null,
          lastError: null,
          pauseReasons: [
            ...(backgroundWorkSnapshot.manualPause ? ['Paused manually'] : []),
            ...getBackgroundWorkPauseReasonLabels(backgroundWorkSnapshot.automaticPauseReasons),
          ],
        });
        return;
      }

      if (!(enabled && managedCollectionId && rootDirectoryHandle)) {
        void service
          .sync({
            enabled,
            indexingPolicyPreset,
            managedCollectionId,
            rootDirectoryHandle,
            scope: { mode: 'full' },
          })
          .catch((error) => {
            reportAsyncError('sync', error);
          });
        return;
      }

      if (isAccessLoading) {
        void service.cancel();
        setSyncStatus({
          state: 'waiting',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle.path,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
        });
        return;
      }

      if (!isTreeRestorationReady) {
        void service.cancel();
        setSyncStatus({
          state: 'waiting',
          managedCollectionId,
          managedCollectionName: null,
          activeRootPath: rootDirectoryHandle.path,
          currentFilePath: null,
          queuedFiles: 0,
          processedFiles: 0,
          lastError: null,
        });
        return;
      }

      const targets = buildSyncLoopTargets({
        rootDirectoryHandle,
        rootDirectoryHandles,
        rootIdByPath,
        scope,
      });
      const myGeneration = syncLoopGenerationRef.current;

      void (async () => {
        for (const target of targets) {
          // Stale-loop guard: a newer triggerSync has fired — stop immediately.
          if (syncLoopGenerationRef.current !== myGeneration) {
            return;
          }
          const adapterRootId = target.handle.rootId ?? rootIdByPath.get(target.handle.path);
          // eslint-disable-next-line react-doctor/async-defer-await, react-doctor/async-await-in-loop -- root sync is intentionally serial so cancellation cannot overlap root mutations.
          const dbRootId = await resolveDbRootId(target.handle.path, adapterRootId);
          if (syncLoopGenerationRef.current !== myGeneration) {
            return;
          }
          await service
            .sync({
              dbRootId,
              enabled,
              indexingPolicyPreset,
              managedCollectionId,
              rootDirectoryHandle: target.handle,
              scope:
                target.scope.mode === 'paths'
                  ? { mode: 'paths', changes: target.scope.changes ?? [] }
                  : { mode: 'full' },
            })
            .catch((error) => {
              reportAsyncError('sync', error);
            });
        }
      })();
    },
    [
      backgroundWorkSnapshot,
      enabled,
      hasHydrated,
      indexingPolicyPreset,
      isAccessLoading,
      isTreeRestorationReady,
      managedCollectionId,
      reportAsyncError,
      resetSyncStatus,
      resolveDbRootId,
      rootDirectoryHandle,
      rootDirectoryHandles,
      rootIdByPath,
      service,
      setSyncStatus,
      triggerWorkspaceIndexBootstrap,
    ]
  );

  const readDatabaseSchedulerSnapshot = useCallback(async (): Promise<unknown> => {
    if (backgroundDb) {
      const scheduler = getDatabaseWorkScheduler(backgroundDb);
      if (scheduler) {
        return scheduler.getSnapshot();
      }
    }
    const schedulerSnapshot =
      typeof window === 'undefined' ? undefined : window.electronAPI?.db?.schedulerSnapshot;
    return schedulerSnapshot ? await schedulerSnapshot() : null;
  }, [backgroundDb]);

  const countExpectedDebugRoots = useCallback(async () => {
    const handles =
      rootDirectoryHandles.length > 0
        ? rootDirectoryHandles
        : rootDirectoryHandle
          ? [rootDirectoryHandle]
          : [];
    return await Promise.all(
      handles.map((handle) =>
        countExpectedWorkspaceIndexFiles({
          fileSystemAdapter,
          policyPreset: indexingPolicyPreset,
          rootHandle: handle,
        })
      )
    );
  }, [fileSystemAdapter, indexingPolicyPreset, rootDirectoryHandle, rootDirectoryHandles]);

  const readDebugHostStatus = useCallback(async (bridgeName: 'chunkingHost' | 'embeddingHost') => {
    const bridge = (window as unknown as Record<typeof bridgeName, unknown>)[bridgeName] as
      | { getStatus?: () => Promise<unknown> }
      | undefined;
    if (typeof bridge?.getStatus !== 'function') {
      return {
        available: false,
        reason: `${bridgeName} bridge unavailable`,
      };
    }
    try {
      return {
        available: true,
        status: await bridge.getStatus(),
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
    const query = backgroundDb?.query as WorkspaceIndexDebugDbQuery | undefined;
    const [
      expectedCounts,
      roots,
      fileRecordsByRoot,
      chunkStatsByRoot,
      jobQueue,
      recentEmbeddingCompletions,
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
      readDatabaseSchedulerSnapshot(),
      readDebugHostStatus('chunkingHost'),
      readDebugHostStatus('embeddingHost'),
    ]);

    return {
      ...(accessIssues.length > 0 ? { accessIssues } : {}),
      chunkingHostStatus,
      chunkStatsByRoot,
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
      managedCollectionId,
      memorySample: readWorkspaceIndexMemorySample(),
      roots,
      selectedDevicePreference,
      syncStatus: useWorkspaceCollectionSyncStatusStore.getState(),
    };
  }, [
    backgroundDb,
    countExpectedDebugRoots,
    managedCollectionId,
    readDatabaseSchedulerSnapshot,
    readDebugHostStatus,
    selectedDevicePreference,
  ]);

  const workspaceIndexDebugApi = useMemo<WorkspaceIndexDebugApi>(
    () =>
      Object.freeze({
        configure: ({ policyPreset }: Parameters<WorkspaceIndexDebugApi['configure']>[0]) => {
          if (policyPreset) {
            setIndexingPolicyPreset(policyPreset);
          }
        },
        countExpected: countExpectedDebugRoots,
        snapshot: readDebugSnapshot,
        triggerFullSync: () => {
          triggerSync({ mode: 'full' });
        },
      }),
    [countExpectedDebugRoots, readDebugSnapshot, setIndexingPolicyPreset, triggerSync]
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
    window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = workspaceIndexDebugApi;
    return () => {
      if (window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === workspaceIndexDebugApi) {
        window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ = undefined;
      }
    };
  }, [workspaceIndexDebugApi]);

  const triggerSyncFromEvent = useEffectEvent(triggerSync);

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
      pause: async () => {
        await service.cancel();
      },
    });
  }, [service]);

  useEffect(() => {
    triggerSync();
    return () => {
      void service?.cancel().catch((error) => {
        reportAsyncError('cancel', error);
      });
    };
  }, [reportAsyncError, service, triggerSync]);

  useEffect(() => {
    const handleRefresh = (event: Event): void => {
      triggerSyncFromEvent(parseRefreshSyncScope(event));
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefresh);
    };
  }, []);

  useEffect(() => {
    const handleQueueDrained = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail = event.detail as { embeddingSetId?: unknown; queue?: unknown } | null;
      if (
        detail?.queue !== 'embeddings' ||
        typeof detail.embeddingSetId !== 'string' ||
        detail.embeddingSetId !== managedCollectionId
      ) {
        return;
      }
      triggerSyncFromEvent({ mode: 'full' });
    };

    window.addEventListener(QUEUE_DRAINED_EVENT, handleQueueDrained);
    return () => {
      window.removeEventListener(QUEUE_DRAINED_EVENT, handleQueueDrained);
    };
  }, [managedCollectionId]);

  // Recovery point for a backfill killed while the window was hidden (e.g. a
  // top-level navigation mid-backfill): re-sync on return to visibility so the
  // 0-changes coverage check can re-enqueue any missing embedding work.
  useResyncOnReturnToVisibility(triggerSync);

  return <>{children}</>;
}
