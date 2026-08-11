import { createWithEqualityFn as create } from 'zustand/traditional';

export type WorkspaceCollectionSyncState =
  | 'blocked'
  | 'disabled'
  | 'idle'
  | 'paused'
  | 'recovering'
  | 'waiting'
  | 'scanning'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | 'error';

export type WorkspaceCollectionSyncBlockedReason = 'missing-provider-key';

export interface WorkspaceCollectionSyncScanSummary {
  changedFiles: number;
  discoveredFiles: number;
  excludedEntries: number;
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

export function __resetWorkspaceCollectionSyncStatusStoreForTests(): void {
  useWorkspaceCollectionSyncStatusStore.setState({
    ...DEFAULT_STATE,
  });
}
