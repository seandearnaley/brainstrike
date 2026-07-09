import { createWithEqualityFn as create } from 'zustand/traditional';
import type { WorkspaceCollectionSyncState } from './workspace-collection-sync-status-store';

export type IndexingActivityStatus = 'unavailable' | 'idle' | 'active' | 'paused' | 'error';

export type IndexingActivityPhase =
  | 'queue'
  | 'manual-backfill'
  | 'background-indexing'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | null;

export interface IndexingQueueSnapshot {
  readonly failed: number;
  readonly nextRunnableAt: string | null;
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  /** Durable, monotonic lifetime total of succeeded jobs — survives pruning. */
  readonly succeededLifetime: number;
}

export interface IndexingBackfillSnapshot {
  readonly current: number | null;
  readonly embeddingSetId: string;
  readonly requestId: string;
  readonly source: 'background-indexing' | 'manual';
  readonly total: number | null;
}

export interface IndexingBackgroundSnapshot {
  readonly enabled: boolean;
  readonly lastError: string | null;
  readonly managedCollectionId: string | null;
  readonly managedCollectionName: string | null;
  readonly paused: boolean;
  readonly pauseReasons: readonly string[];
  readonly state: WorkspaceCollectionSyncState;
}

export interface IndexingWorkerSnapshot {
  readonly lastError: string | null;
  readonly state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping' | 'unknown';
}

export interface IndexingManagedCollectionStats {
  readonly chunkCount: number;
  readonly dirty: boolean;
  readonly embeddedChunkCount: number;
  readonly embeddingSetId: string;
  readonly fileCount: number;
  readonly lastRefreshedAt: string;
  readonly pendingChunkCount: number;
}

export interface IndexingManagedCollectionStatsState {
  readonly collectionId: string | null;
  readonly error: string | null;
  readonly stats: IndexingManagedCollectionStats | null;
  readonly status: 'unavailable' | 'loading' | 'pending' | 'ready' | 'error';
}

export type IndexingDatabaseWorkPriority = 'foreground' | 'normal' | 'background';

export interface IndexingDatabaseWorkSnapshot {
  readonly backgroundWaiting: boolean;
  readonly backgroundWaitingSince: number | null;
  readonly backgroundYieldCount: number;
  readonly currentBackgroundWaitMs: number;
  readonly foregroundQuietMs: number;
  readonly lastBackgroundYieldAt: number | null;
  readonly lastCompletedAt: number | null;
  readonly lastForegroundAt: number | null;
  readonly lastNormalAt: number | null;
  readonly lastStartedAt: number | null;
  readonly priorityStats: Record<IndexingDatabaseWorkPriority, IndexingDatabaseWorkPriorityStats>;
  readonly queued: Record<IndexingDatabaseWorkPriority, number>;
  readonly queuedLabels: Record<IndexingDatabaseWorkPriority, readonly (string | null)[]>;
  readonly runningLabel: string | null;
  readonly runningPriority: IndexingDatabaseWorkPriority | null;
  readonly snapshotAt: number;
}

export interface IndexingDatabaseWorkPriorityStats {
  readonly completed: number;
  readonly lastCompletedLabel: string | null;
  readonly lastStartedLabel: string | null;
  readonly longestWaitMs: number;
  readonly queued: number;
  readonly serviceP50Ms: number;
  readonly serviceP95Ms: number;
  readonly started: number;
  readonly totalServiceMs: number;
  readonly totalWaitMs: number;
  readonly waitP50Ms: number;
  readonly waitP95Ms: number;
}

export interface IndexingActivitySnapshot {
  readonly activeBackfills: readonly IndexingBackfillSnapshot[];
  readonly background: IndexingBackgroundSnapshot;
  readonly databaseWork: IndexingDatabaseWorkSnapshot | null;
  readonly lastError: string | null;
  readonly lastUpdatedAt: number | null;
  readonly phase: IndexingActivityPhase;
  readonly queue: IndexingQueueSnapshot | null;
  readonly status: IndexingActivityStatus;
  readonly worker: IndexingWorkerSnapshot | null;
}

interface IndexingActivityData {
  readonly indexingActivityError: string | null;
  readonly managedCollectionStats: IndexingManagedCollectionStatsState;
  readonly snapshot: IndexingActivitySnapshot;
}

interface IndexingActivityActions {
  readonly resetIndexingActivity: () => void;
  readonly setBackfills: (backfills: readonly IndexingBackfillSnapshot[]) => void;
  readonly setBackgroundSnapshot: (background: IndexingBackgroundSnapshot) => void;
  readonly setDatabaseWorkSnapshot: (databaseWork: IndexingDatabaseWorkSnapshot | null) => void;
  readonly setIndexingActivityError: (error: string | null) => void;
  readonly setManagedCollectionStats: (state: IndexingManagedCollectionStatsState) => void;
  readonly setQueueSnapshot: (queue: IndexingQueueSnapshot | null) => void;
  readonly setWorkerSnapshot: (worker: IndexingWorkerSnapshot | null) => void;
}

export type IndexingActivityStore = IndexingActivityData & IndexingActivityActions;

type IndexingActivitySnapshotInput = Pick<
  IndexingActivitySnapshot,
  'activeBackfills' | 'background' | 'databaseWork' | 'lastUpdatedAt' | 'queue' | 'worker'
> & {
  readonly activityError: string | null;
};

const DEFAULT_BACKGROUND_SNAPSHOT: IndexingBackgroundSnapshot = {
  enabled: false,
  lastError: null,
  managedCollectionId: null,
  managedCollectionName: null,
  paused: false,
  pauseReasons: [],
  state: 'disabled',
};

const DEFAULT_INDEXING_ACTIVITY_SNAPSHOT: IndexingActivitySnapshot = {
  activeBackfills: [],
  background: DEFAULT_BACKGROUND_SNAPSHOT,
  databaseWork: null,
  lastError: null,
  lastUpdatedAt: null,
  phase: null,
  queue: null,
  status: 'unavailable',
  worker: null,
};

const DEFAULT_MANAGED_COLLECTION_STATS: IndexingManagedCollectionStatsState = {
  collectionId: null,
  error: null,
  stats: null,
  status: 'unavailable',
};

function isQueueActive(queue: IndexingQueueSnapshot | null): boolean {
  return queue !== null && (queue.queued > 0 || queue.running > 0);
}

function isQueueErrored(queue: IndexingQueueSnapshot | null): boolean {
  return queue !== null && queue.failed > 0;
}

function isDatabaseWorkActive(databaseWork: IndexingDatabaseWorkSnapshot | null): boolean {
  return (
    databaseWork !== null &&
    (databaseWork.backgroundWaiting ||
      databaseWork.runningPriority !== null ||
      databaseWork.queued.foreground > 0 ||
      databaseWork.queued.normal > 0 ||
      databaseWork.queued.background > 0)
  );
}

function isBackgroundActive(background: IndexingBackgroundSnapshot): boolean {
  return (
    background.state === 'recovering' ||
    background.state === 'waiting' ||
    background.state === 'scanning' ||
    background.state === 'importing' ||
    background.state === 'chunking' ||
    background.state === 'embedding'
  );
}

function isBackgroundUnavailable(background: IndexingBackgroundSnapshot): boolean {
  return (
    !background.enabled &&
    background.lastError === null &&
    background.state === 'disabled' &&
    background.managedCollectionId === null &&
    background.managedCollectionName === null &&
    background.pauseReasons.length === 0
  );
}

function getBackgroundPhase(background: IndexingBackgroundSnapshot): IndexingActivityPhase {
  if (background.state === 'importing') {
    return 'importing';
  }
  if (background.state === 'chunking') {
    return 'chunking';
  }
  if (background.state === 'embedding') {
    return 'embedding';
  }
  return 'background-indexing';
}

function getBackfillPhase(backfills: readonly IndexingBackfillSnapshot[]): IndexingActivityPhase {
  if (backfills.length === 0) {
    return null;
  }
  return backfills.some((backfill) => backfill.source === 'manual')
    ? 'manual-backfill'
    : 'background-indexing';
}

function getQueueErrorMessage(queue: IndexingQueueSnapshot): string {
  return `${queue.failed} embedding job${queue.failed === 1 ? '' : 's'} failed`;
}

function isWorkerAvailabilitySignal(worker: IndexingWorkerSnapshot | null): boolean {
  return worker !== null && worker.state !== 'stopped' && worker.state !== 'unknown';
}

function buildSnapshot(
  args: IndexingActivitySnapshotInput,
  outcome: Pick<IndexingActivitySnapshot, 'lastError' | 'phase' | 'status'>
): IndexingActivitySnapshot {
  return {
    activeBackfills: args.activeBackfills,
    background: args.background,
    databaseWork: args.databaseWork,
    lastUpdatedAt: args.lastUpdatedAt,
    queue: args.queue,
    worker: args.worker,
    ...outcome,
  };
}

function deriveErrorSnapshot(args: IndexingActivitySnapshotInput): IndexingActivitySnapshot | null {
  if (args.activityError) {
    return buildSnapshot(args, {
      lastError: args.activityError,
      phase:
        getBackfillPhase(args.activeBackfills) ??
        (isQueueErrored(args.queue) || isQueueActive(args.queue)
          ? 'queue'
          : isBackgroundUnavailable(args.background)
            ? null
            : 'background-indexing'),
      status: 'error',
    });
  }

  if (args.worker?.state === 'error') {
    return buildSnapshot(args, {
      lastError: args.worker.lastError ?? 'Embedding worker failed',
      phase: 'embedding',
      status: 'error',
    });
  }

  if (args.background.state === 'blocked' || args.background.state === 'error') {
    return buildSnapshot(args, {
      lastError: args.background.lastError ?? 'Background indexing failed',
      phase: 'background-indexing',
      status: 'error',
    });
  }

  if (args.queue && isQueueErrored(args.queue)) {
    return buildSnapshot(args, {
      lastError: getQueueErrorMessage(args.queue),
      phase: 'queue',
      status: 'error',
    });
  }

  return null;
}

function deriveActiveSnapshot(
  args: IndexingActivitySnapshotInput
): IndexingActivitySnapshot | null {
  const backfillPhase = getBackfillPhase(args.activeBackfills);
  if (backfillPhase) {
    return buildSnapshot(args, {
      lastError: null,
      phase: backfillPhase,
      status: 'active',
    });
  }

  if (isBackgroundActive(args.background)) {
    return buildSnapshot(args, {
      lastError: null,
      phase: getBackgroundPhase(args.background),
      status: 'active',
    });
  }

  if (isQueueActive(args.queue)) {
    return buildSnapshot(args, {
      lastError: null,
      phase: 'queue',
      status: 'active',
    });
  }

  if (isDatabaseWorkActive(args.databaseWork)) {
    return buildSnapshot(args, {
      lastError: null,
      phase:
        args.databaseWork?.backgroundWaiting || args.databaseWork?.runningPriority === 'background'
          ? 'background-indexing'
          : 'queue',
      status: 'active',
    });
  }

  return null;
}

function deriveSnapshot(args: IndexingActivitySnapshotInput): IndexingActivitySnapshot {
  const errorSnapshot = deriveErrorSnapshot(args);
  if (errorSnapshot) {
    return errorSnapshot;
  }

  if (args.background.paused || args.background.state === 'paused') {
    return buildSnapshot(args, {
      lastError: null,
      phase: 'background-indexing',
      status: 'paused',
    });
  }

  const activeSnapshot = deriveActiveSnapshot(args);
  if (activeSnapshot) {
    return activeSnapshot;
  }

  if (args.worker?.state === 'starting' || args.worker?.state === 'running') {
    return buildSnapshot(args, {
      lastError: null,
      phase: 'embedding',
      status: args.worker.state === 'running' ? 'idle' : 'active',
    });
  }

  if (
    args.queue !== null ||
    args.databaseWork !== null ||
    !isBackgroundUnavailable(args.background) ||
    isWorkerAvailabilitySignal(args.worker)
  ) {
    return buildSnapshot(args, {
      lastError: null,
      phase: null,
      status: 'idle',
    });
  }

  return buildSnapshot(args, {
    lastError: null,
    phase: null,
    status: 'unavailable',
  });
}

function deriveNextSnapshot(
  current: IndexingActivitySnapshot,
  activityError: string | null,
  patch: Partial<
    Pick<
      IndexingActivitySnapshot,
      'activeBackfills' | 'background' | 'databaseWork' | 'lastUpdatedAt' | 'queue' | 'worker'
    >
  >
): IndexingActivitySnapshot {
  return deriveSnapshot({
    activeBackfills: patch.activeBackfills ?? current.activeBackfills,
    activityError,
    background: patch.background ?? current.background,
    databaseWork: patch.databaseWork === undefined ? current.databaseWork : patch.databaseWork,
    lastUpdatedAt: patch.lastUpdatedAt ?? current.lastUpdatedAt,
    queue: patch.queue === undefined ? current.queue : patch.queue,
    worker: patch.worker === undefined ? current.worker : patch.worker,
  });
}

function now(): number {
  return Date.now();
}

export const useIndexingActivityStore = create<IndexingActivityStore>()((set) => ({
  indexingActivityError: null,
  managedCollectionStats: DEFAULT_MANAGED_COLLECTION_STATS,
  resetIndexingActivity: () =>
    set({
      indexingActivityError: null,
      managedCollectionStats: DEFAULT_MANAGED_COLLECTION_STATS,
      snapshot: DEFAULT_INDEXING_ACTIVITY_SNAPSHOT,
    }),
  setBackfills: (backfills: readonly IndexingBackfillSnapshot[]) =>
    set((state) => ({
      snapshot: deriveNextSnapshot(state.snapshot, state.indexingActivityError, {
        activeBackfills: [...backfills],
        lastUpdatedAt: now(),
      }),
    })),
  setBackgroundSnapshot: (background: IndexingBackgroundSnapshot) =>
    set((state) => ({
      snapshot: deriveNextSnapshot(state.snapshot, state.indexingActivityError, {
        background: {
          ...background,
          pauseReasons: [...background.pauseReasons],
        },
        lastUpdatedAt: now(),
      }),
    })),
  setDatabaseWorkSnapshot: (databaseWork: IndexingDatabaseWorkSnapshot | null) =>
    set((state) => ({
      snapshot: deriveNextSnapshot(state.snapshot, state.indexingActivityError, {
        databaseWork,
        lastUpdatedAt: now(),
      }),
    })),
  setIndexingActivityError: (error: string | null) =>
    set((state) => ({
      indexingActivityError: error,
      snapshot: deriveNextSnapshot(state.snapshot, error, { lastUpdatedAt: now() }),
    })),
  setManagedCollectionStats: (managedCollectionStats: IndexingManagedCollectionStatsState) =>
    set({ managedCollectionStats }),
  setQueueSnapshot: (queue: IndexingQueueSnapshot | null) =>
    set((state) => ({
      snapshot: deriveNextSnapshot(state.snapshot, state.indexingActivityError, {
        lastUpdatedAt: now(),
        queue,
      }),
    })),
  setWorkerSnapshot: (worker: IndexingWorkerSnapshot | null) =>
    set((state) => ({
      snapshot: deriveNextSnapshot(state.snapshot, state.indexingActivityError, {
        lastUpdatedAt: now(),
        worker,
      }),
    })),
  snapshot: DEFAULT_INDEXING_ACTIVITY_SNAPSHOT,
}));

export function __resetIndexingActivityStoreForTests(): void {
  useIndexingActivityStore.setState({
    indexingActivityError: null,
    managedCollectionStats: DEFAULT_MANAGED_COLLECTION_STATS,
    snapshot: DEFAULT_INDEXING_ACTIVITY_SNAPSHOT,
  });
}
