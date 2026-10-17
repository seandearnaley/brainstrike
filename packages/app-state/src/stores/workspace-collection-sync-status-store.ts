import { createLogger } from '@brainstrike/logging';
import { createWithEqualityFn as create } from 'zustand/traditional';

/**
 * `unconfigured` (BST-1335): setup is incomplete — e.g. background indexing
 * is enabled and a managed collection exists, but no workspace root has been
 * selected yet. Nothing is broken; there is simply nothing to sync yet. It is
 * intentionally distinct from `error`: the durable-logging invariant below
 * only fires for genuine `error`/`blocked` transitions, so entering
 * `unconfigured` is never persisted to `brainstrike_diagnostic_events`.
 */
export type WorkspaceCollectionSyncState =
  | 'blocked'
  | 'disabled'
  | 'idle'
  | 'paused'
  | 'recovering'
  | 'unconfigured'
  | 'waiting'
  | 'scanning'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | 'error';

/**
 * Why sync is blocked when a person must act: a hosted provider key is missing, or the native
 * embedding host stopped responding and only Retry indexing restarts it (BST-2104).
 */
export type WorkspaceCollectionSyncBlockedReason =
  | 'embedding-host-unresponsive'
  | 'missing-provider-key';

export interface WorkspaceCollectionSyncScanSummary {
  changedFiles: number;
  discoveredFiles: number;
  excludedEntries: number;
  /** Directories whose listing was capped by the adapter — scan coverage is partial. */
  truncatedDirectories: number;
  unchangedFiles: number;
}

export interface WorkspaceCollectionSyncImportProgress {
  completed: number;
  current: string | null;
  errorCount: number;
  total: number;
}

export interface WorkspaceCollectionSyncChunkingProgress {
  chunksCreated: number;
  currentFile: string | null;
  filesProcessed: number;
  strategyUsed: string | null;
  totalFiles: number;
}

export interface WorkspaceCollectionSyncEmbeddingProgress {
  chunksProcessed: number;
  currentChunk: string | null;
  modelName: string | null;
  totalChunks: number;
}

export interface WorkspaceCollectionSyncQueueProgress {
  failed: number;
  lastError: string | null;
  lastEvent: {
    chunkId: string;
    elapsedMs?: number;
    errorMessage?: string;
    model: string;
    status: 'queued' | 'completed' | 'error';
  } | null;
  pending: number;
  processed: number;
  totalQueued: number;
}

export interface WorkspaceCollectionSyncStatusData {
  activeRootPath: string | null;
  backfillRequestId: string | null;
  blockedReason: WorkspaceCollectionSyncBlockedReason | null;
  chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  currentFilePath: string | null;
  embeddingProgress: WorkspaceCollectionSyncEmbeddingProgress | null;
  importProgress: WorkspaceCollectionSyncImportProgress | null;
  lastError: string | null;
  managedCollectionId: string | null;
  managedCollectionName: string | null;
  pauseReasons: string[];
  processedFiles: number;
  queuedFiles: number;
  queueProgress: WorkspaceCollectionSyncQueueProgress | null;
  scanSummary: WorkspaceCollectionSyncScanSummary | null;
  state: WorkspaceCollectionSyncState;
  /**
   * Files the idle coverage audit verified can never be indexed (their content
   * fails the import gate: null bytes, binary behind a text extension,
   * unreadable). Null until an audit has run; refreshed by each audit.
   */
  unindexableFileCount: number | null;
}

export type WorkspaceCollectionSyncStatusPatch = Partial<WorkspaceCollectionSyncStatusData>;

interface WorkspaceCollectionSyncStatusActions {
  reset: () => void;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}

export type WorkspaceCollectionSyncStatusStore = WorkspaceCollectionSyncStatusData &
  WorkspaceCollectionSyncStatusActions;

const DEFAULT_STATE: WorkspaceCollectionSyncStatusData = {
  activeRootPath: null,
  backfillRequestId: null,
  blockedReason: null,
  chunkingProgress: null,
  currentFilePath: null,
  embeddingProgress: null,
  importProgress: null,
  lastError: null,
  managedCollectionId: null,
  managedCollectionName: null,
  pauseReasons: [],
  processedFiles: 0,
  queuedFiles: 0,
  queueProgress: null,
  scanSummary: null,
  state: 'disabled',
  unindexableFileCount: null,
};

export const useWorkspaceCollectionSyncStatusStore = create<WorkspaceCollectionSyncStatusStore>()(
  (set) => ({
    ...DEFAULT_STATE,
    reset: () =>
      set({
        ...DEFAULT_STATE,
      }),
    setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => set(() => patch),
  })
);

const errorTransitionLogger = createLogger('WorkspaceCollectionSyncStatus');

/**
 * Durable-logging invariant (BST-1257): any transition of the sync surface
 * into an error/blocked state is logged at warn+ so it reaches the durable
 * diagnostic sinks — the BST-1255 indexer halt surfaced ONLY in the status
 * banner and left zero durable trace. Subscribing at the store keeps this a
 * single chokepoint no status writer can bypass; the value-change guard keeps
 * poll loops that re-set an identical error from spamming.
 */
useWorkspaceCollectionSyncStatusStore.subscribe((state, prevState) => {
  // Scoped to genuine error/blocked states: coverage audits set lastError
  // with state 'waiting' and already warn at the producer (BST-1257 review).
  if (!state.lastError || (state.state !== 'error' && state.state !== 'blocked')) {
    return;
  }
  const enteredErrorState =
    state.state !== prevState.state && (state.state === 'error' || state.state === 'blocked');
  const changed =
    state.lastError !== prevState.lastError ||
    state.blockedReason !== prevState.blockedReason ||
    enteredErrorState;
  if (!changed) {
    return;
  }
  const context = {
    activeRootPath: state.activeRootPath,
    blockedReason: state.blockedReason,
    lastError: state.lastError,
    managedCollectionId: state.managedCollectionId,
    state: state.state,
  };
  if (state.state === 'blocked') {
    errorTransitionLogger.warn('Workspace collection sync blocked', context);
    return;
  }
  errorTransitionLogger.error('Workspace collection sync entered an error state', context);
});

export function __resetWorkspaceCollectionSyncStatusStoreForTests(): void {
  useWorkspaceCollectionSyncStatusStore.setState({
    ...DEFAULT_STATE,
  });
}
