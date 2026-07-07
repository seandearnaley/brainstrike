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

export function createAbortError(message: string): Error {
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
    dispose() {
      clearTimer();
      pendingPath = null;
    },
    flush(path = pendingPath) {
      emitNow(path ?? null);
    },
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
  };
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  );
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
        currentFilePath: null,
        pauseReasons: [],
        processedFiles: progress.total,
        queuedFiles: base.queueProgress?.pending ?? 0,
        state: 'idle',
      };
    case 'embedding':
      return {
        ...base,
        currentFilePath: progress.embeddingProgress?.currentChunk ?? progress.current ?? null,
        pauseReasons: [],
        processedFiles: progress.embeddingProgress?.chunksProcessed ?? progress.completed,
        queuedFiles: progress.queueProgress?.pending ?? 0,
        state: 'embedding',
      };
    case 'chunking':
      return {
        ...base,
        currentFilePath: progress.chunkingProgress?.currentFile ?? progress.current ?? null,
        pauseReasons: [],
        processedFiles: progress.chunkingProgress?.filesProcessed ?? progress.completed,
        queuedFiles: 0,
        state: 'chunking',
      };
    default:
      return {
        ...base,
        currentFilePath: progress.current ?? null,
        pauseReasons: [],
        processedFiles: progress.completed,
        queuedFiles: Math.max(0, progress.total - progress.completed),
        state: 'importing',
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
    chunkingProgress: toWorkspaceCollectionSyncChunkingProgress(progress),
    embeddingProgress: toWorkspaceCollectionSyncEmbeddingProgress(progress),
    importProgress: toWorkspaceCollectionSyncImportProgress(progress),
    lastError: progress.errors[0]?.error ?? null,
    managedCollectionId,
    managedCollectionName,
    queueProgress: toWorkspaceCollectionSyncQueueProgress(progress),
    scanSummary: summary,
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
    activeRootPath: args.rootPath,
    backfillRequestId: args.requestId ?? null,
    currentFilePath: currentMessage,
    lastError: null,
    managedCollectionId: args.collection.id,
    managedCollectionName: args.managedCollectionName,
    pauseReasons: [],
    state: args.state ?? 'embedding',
    ...(args.scanSummary
      ? {
          importProgress: {
            completed: args.scanSummary.changedFiles,
            current: null,
            errorCount: 0,
            total: args.scanSummary.changedFiles,
          },
          processedFiles: args.scanSummary.discoveredFiles,
          scanSummary: args.scanSummary,
        }
      : {}),
    chunkingProgress: args.chunkingProgress,
    embeddingProgress: {
      chunksProcessed: processedChunks,
      currentChunk: currentMessage,
      modelName: args.collection.modelId,
      totalChunks,
    },
    queuedFiles: Math.max(0, totalChunks - processedChunks),
    queueProgress: {
      failed: 0,
      lastError: null,
      lastEvent: null,
      pending: Math.max(0, totalChunks - processedChunks),
      processed: processedChunks,
      totalQueued: totalChunks,
    },
  };
}

export function toWorkspaceCollectionSyncImportProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncImportProgress {
  return {
    completed: progress.completed,
    current: progress.current ?? null,
    errorCount: progress.errors.length,
    total: progress.total,
  };
}

export function toWorkspaceCollectionSyncChunkingProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncChunkingProgress | null {
  if (!progress.chunkingProgress) {
    return null;
  }
  return {
    chunksCreated: progress.chunkingProgress.chunksCreated,
    currentFile: progress.chunkingProgress.currentFile ?? null,
    filesProcessed: progress.chunkingProgress.filesProcessed,
    strategyUsed: progress.chunkingProgress.strategyUsed ?? null,
    totalFiles: progress.chunkingProgress.totalFiles,
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
    currentChunk: progress.embeddingProgress.currentChunk ?? null,
    modelName: progress.embeddingProgress.modelName ?? null,
    totalChunks: progress.embeddingProgress.totalChunks,
  };
}

function toWorkspaceCollectionSyncQueueProgress(
  progress: EnhancedImportProgress
): WorkspaceCollectionSyncQueueProgress | null {
  if (!progress.queueProgress) {
    return null;
  }
  return {
    failed: progress.queueProgress.failed,
    lastError: progress.queueProgress.lastError,
    lastEvent: progress.queueProgress.lastEvent ?? null,
    pending: progress.queueProgress.pending,
    processed: progress.queueProgress.processed,
    totalQueued: progress.queueProgress.totalQueued,
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
      chunksCreated: args.cumulativeChunksCreated + args.batchChunking.chunksCreated,
      filesProcessed: args.cumulativeFilesChunked + args.batchChunking.filesProcessed,
      totalFiles: args.totalFiles,
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
    chunksCreated: args.cumulativeChunksCreated,
    filesProcessed: args.cumulativeFilesChunked,
    totalFiles: args.totalFiles,
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
        error: 'Background cache import error.',
        file: `batch:${errorIndex}`,
      }
    );
  });
}
