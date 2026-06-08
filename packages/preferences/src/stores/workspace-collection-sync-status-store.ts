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
}

export type WorkspaceCollectionSyncStatusPatch = Partial<WorkspaceCollectionSyncStatusData>;

interface WorkspaceCollectionSyncStatusActions {
  reset: () => void;
  setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => void;
}

export type WorkspaceCollectionSyncStatusStore = WorkspaceCollectionSyncStatusData &
  WorkspaceCollectionSyncStatusActions;

const DEFAULT_STATE: WorkspaceCollectionSyncStatusData = {
  state: 'disabled',
  managedCollectionId: null,
  managedCollectionName: null,
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
  activeRootPath: null,
  pauseReasons: [],
};

export const useWorkspaceCollectionSyncStatusStore = create<WorkspaceCollectionSyncStatusStore>()(
  (set) => ({
    ...DEFAULT_STATE,
    setStatus: (patch: WorkspaceCollectionSyncStatusPatch) => set(() => patch),
    reset: () =>
      set({
        ...DEFAULT_STATE,
      }),
  })
);

export function __resetWorkspaceCollectionSyncStatusStoreForTests(): void {
  useWorkspaceCollectionSyncStatusStore.setState({
    ...DEFAULT_STATE,
  });
}
