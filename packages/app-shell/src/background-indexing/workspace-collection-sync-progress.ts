import type { ChunkingStrategy, EmbeddingSet } from '@brainstrike/db';
import type { EnhancedImportProgress } from '@brainstrike/file-import';
import type {
  WorkspaceCollectionSyncChunkingProgress,
  WorkspaceCollectionSyncEmbeddingProgress,
  WorkspaceCollectionSyncImportProgress,
  WorkspaceCollectionSyncQueueProgress,
  WorkspaceCollectionSyncScanSummary,
  WorkspaceCollectionSyncStatusPatch,
} from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';

const SCANNING_STATUS_THROTTLE_MS = 100;
const BACKFILL_DRAIN_POLL_BASE_MS = 250;
const BACKFILL_DRAIN_POLL_MAX_MS = 2000;

interface WorkspaceCollectionSyncProgressStatusBase {
  activeRootPath: string;
  chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  embeddingProgress: WorkspaceCollectionSyncEmbeddingProgress | null;
  importProgress: WorkspaceCollectionSyncImportProgress;
  lastError: string | null;
  managedCollectionId: string;
  managedCollectionName: string | null;
  queueProgress: WorkspaceCollectionSyncQueueProgress | null;
  scanSummary: WorkspaceCollectionSyncScanSummary;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(
  signal?: AbortSignal,
  message = 'Workspace collection sync was cancelled.'
): void {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

export function createScanningStatusReporter(
  emit: (path: string | null) => void,
  throttleMs = SCANNING_STATUS_THROTTLE_MS
): {
  dispose: () => void;
  flush: (path?: string | null) => void;
  report: (path: string | null) => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPath: string | null = null;
  let lastEmitAt = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emitNow = (path: string | null): void => {
    clearTimer();
    pendingPath = null;
    lastEmitAt = Date.now();
    emit(path);
  };

  return {
    report(path) {
      pendingPath = path;
      const now = Date.now();
      if (now - lastEmitAt >= throttleMs) {
        emitNow(path);
        return;
      }
      if (timer !== null) {
        return;
      }
      timer = setTimeout(
        () => {
          emitNow(pendingPath);
        },
        Math.max(0, throttleMs - (now - lastEmitAt))
      );
    },
    flush(path = pendingPath) {
      emitNow(path ?? null);
    },
    dispose() {
      clearTimer();
      pendingPath = null;
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(createAbortError('Workspace collection sync was cancelled.'));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function getBackfillDrainPollDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, attempt);
  return Math.min(BACKFILL_DRAIN_POLL_MAX_MS, BACKFILL_DRAIN_POLL_BASE_MS * 2 ** safeAttempt);
}

export function dispatchQueueDrainedEvent(embeddingSetId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent('brainstrike:queue-drained', {
      detail: { embeddingSetId, queue: 'embeddings' as const },
    })
  );
}

export function mapEnhancedProgressToStatus(
  progress: EnhancedImportProgress,
  managedCollectionId: string,
  managedCollectionName: string | null,
  rootPath: string,
  summary: WorkspaceCollectionSyncScanSummary
): WorkspaceCollectionSyncStatusPatch {
  const base = buildEnhancedProgressStatusBase(
    progress,
    managedCollectionId,
    managedCollectionName,
    rootPath,
    summary
  );

  switch (progress.phase) {
    case 'complete':
      return {
        ...base,
        state: 'idle',
        pauseReasons: [],
        processedFiles: progress.total,
        queuedFiles: base.queueProgress?.pending ?? 0,
        currentFilePath: null,
      };
    case 'embedding':
      return {
        ...base,
        state: 'embedding',
        pauseReasons: [],
        processedFiles: progress.embeddingProgress?.chunksProcessed ?? progress.completed,
        queuedFiles: progress.queueProgress?.pending ?? 0,
        currentFilePath: progress.embeddingProgress?.currentChunk ?? progress.current ?? null,
      };
    case 'chunking':
      return {
        ...base,
        state: 'chunking',
        pauseReasons: [],
        processedFiles: progress.chunkingProgress?.filesProcessed ?? progress.completed,
        queuedFiles: 0,
        currentFilePath: progress.chunkingProgress?.currentFile ?? progress.current ?? null,
      };
    default:
      return {
        ...base,
        state: 'importing',
        pauseReasons: [],
        processedFiles: progress.completed,
        queuedFiles: Math.max(0, progress.total - progress.completed),
        currentFilePath: progress.current ?? null,
      };
  }
}

function buildEnhancedProgressStatusBase(
  progress: EnhancedImportProgress,
  managedCollectionId: string,
  managedCollectionName: string | null,
  rootPath: string,
  summary: WorkspaceCollectionSyncScanSummary
): WorkspaceCollectionSyncProgressStatusBase {
  return {
    activeRootPath: rootPath,
    managedCollectionId,
    managedCollectionName,
    scanSummary: summary,
    importProgress: toWorkspaceCollectionSyncImportProgress(progress),
    chunkingProgress: toWorkspaceCollectionSyncChunkingProgress(progress),
    embeddingProgress: toWorkspaceCollectionSyncEmbeddingProgress(progress),
    queueProgress: toWorkspaceCollectionSyncQueueProgress(progress),
    lastError: progress.errors[0]?.error ?? null,
  };
}

export function mapBackfillProgressToStatus(args: {
  chunkingProgress: WorkspaceCollectionSyncChunkingProgress | null;
  collection: EmbeddingSet;
  current?: number;
  managedCollectionName: string | null;
  message?: string;
  requestId?: string | null;
  rootPath: string;
  scanSummary?: WorkspaceCollectionSyncScanSummary;
  state?: 'embedding' | 'recovering';
  total?: number;
}): WorkspaceCollectionSyncStatusPatch {
  const totalChunks = Math.max(0, args.total ?? 0);
  const processedChunks = Math.min(totalChunks, Math.max(0, args.current ?? 0));
  const currentMessage = args.message?.trim() ? args.message : null;

  return {
    state: args.state ?? 'embedding',
    pauseReasons: [],
    managedCollectionId: args.collection.id,
    managedCollectionName: args.managedCollectionName,
    backfillRequestId: args.requestId ?? null,
    activeRootPath: args.rootPath,
    currentFilePath: currentMessage,
    lastError: null,
    ...(args.scanSummary
      ? {
          scanSummary: args.scanSummary,
          importProgress: {
            completed: args.scanSummary.changedFiles,
            total: args.scanSummary.changedFiles,
            current: null,
            errorCount: 0,
          },
          processedFiles: args.scanSummary.discoveredFiles,
        }
      : {}),
    chunkingProgress: args.chunkingProgress,
    embeddingProgress: {
      chunksProcessed: processedChunks,
      totalChunks,
      currentChunk: currentMessage,
      modelName: args.collection.modelId,
    },
    queueProgress: {
      failed: 0,
      lastError: null,
      lastEvent: null,
      pending: Math.max(0, totalChunks - processedChunks),
      processed: processedChunks,
      totalQueued: totalChunks,
    },
    queuedFiles: Math.max(0, totalChunks - processedChunks),
  };
}

export function toWorkspaceCollectionSyncImportProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncImportProgress {
  return {
    completed: progress.completed,
    total: progress.total,
    current: progress.current ?? null,
    errorCount: progress.errors.length,
  };
}

export function toWorkspaceCollectionSyncChunkingProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncChunkingProgress | null {
  if (!progress.chunkingProgress) {
    return null;
  }
  return {
    filesProcessed: progress.chunkingProgress.filesProcessed,
    totalFiles: progress.chunkingProgress.totalFiles,
    currentFile: progress.chunkingProgress.currentFile ?? null,
    chunksCreated: progress.chunkingProgress.chunksCreated,
    strategyUsed: progress.chunkingProgress.strategyUsed ?? null,
  };
}

function toWorkspaceCollectionSyncEmbeddingProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncEmbeddingProgress | null {
  if (!progress.embeddingProgress) {
    return null;
  }
  return {
    chunksProcessed: progress.embeddingProgress.chunksProcessed,
    totalChunks: progress.embeddingProgress.totalChunks,
    currentChunk: progress.embeddingProgress.currentChunk ?? null,
    modelName: progress.embeddingProgress.modelName ?? null,
  };
}

function toWorkspaceCollectionSyncQueueProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncQueueProgress | null {
  if (!progress.queueProgress) {
    return null;
  }
  return {
    pending: progress.queueProgress.pending,
    processed: progress.queueProgress.processed,
    failed: progress.queueProgress.failed,
    totalQueued: progress.queueProgress.totalQueued,
    lastError: progress.queueProgress.lastError,
    lastEvent: progress.queueProgress.lastEvent ?? null,
  };
}

export function buildNormalizedChunkingProgress(args: {
  batchChunking: EnhancedImportProgress['chunkingProgress'] | undefined;
  cumulativeChunksCreated: number;
  cumulativeFilesChunked: number;
  latestChunkingProgress: EnhancedImportProgress['chunkingProgress'] | null;
  latestStrategyUsed: ChunkingStrategy | null;
  totalFiles: number;
}): EnhancedImportProgress['chunkingProgress'] | undefined {
  if (args.batchChunking) {
    return {
      ...args.batchChunking,
      filesProcessed: args.cumulativeFilesChunked + args.batchChunking.filesProcessed,
      totalFiles: args.totalFiles,
      chunksCreated: args.cumulativeChunksCreated + args.batchChunking.chunksCreated,
      ...(args.batchChunking.strategyUsed
        ? { strategyUsed: args.batchChunking.strategyUsed }
        : args.latestStrategyUsed
          ? { strategyUsed: args.latestStrategyUsed }
          : {}),
    };
  }
  if (!args.latestChunkingProgress) {
    return;
  }
  return {
    ...args.latestChunkingProgress,
    filesProcessed: args.cumulativeFilesChunked,
    totalFiles: args.totalFiles,
    chunksCreated: args.cumulativeChunksCreated,
    ...(args.latestStrategyUsed ? { strategyUsed: args.latestStrategyUsed } : {}),
  };
}

export function buildBatchImportErrors(
  progress: EnhancedImportProgress,
  cumulativeErrorCount: number
): EnhancedImportProgress['errors'] {
  return Array.from({ length: cumulativeErrorCount + progress.errors.length }, (_, errorIndex) => {
    const batchError = progress.errors[errorIndex - cumulativeErrorCount];
    return (
      batchError ?? {
        file: `batch:${errorIndex}`,
        error: 'Background cache import error.',
      }
    );
  });
}
