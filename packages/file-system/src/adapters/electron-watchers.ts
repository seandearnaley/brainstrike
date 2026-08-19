import type { FileSystemChange, FileSystemWatchBatchMetadata } from '../types.js';

// Shared change-batching primitive for the watcher service (BST-568). The
// legacy chokidar / recursive-fs.watch engines that used to live here were
// removed in slice 4 — @parcel/watcher (see ./parcel-watchers.ts) is the only
// engine on every platform.
export const FS_WATCH_BATCH_WINDOW_MS = 150;
// Invariant: keep watcher event buffering bounded during bursty workloads.
export const FS_WATCH_MAX_BATCH_SIZE = 500;

export interface FileSystemChangeBatcher {
  dispose: () => void;
  enqueue: (change: FileSystemChange) => void;
  markOmittedChange: () => void;
}

export function createFileSystemChangeBatcher(
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void
): FileSystemChangeBatcher {
  let batch: FileSystemChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let omittedChanges = false;

  const flushBatch = (): void => {
    batchTimer = null;
    if (batch.length > 0 || omittedChanges) {
      const changes = batch;
      const metadata = omittedChanges ? ({ omittedChanges: true } as const) : undefined;
      batch = [];
      omittedChanges = false;
      if (metadata) {
        callback(changes, metadata);
      } else {
        callback(changes);
      }
    }
  };

  const scheduleBatchFlush = (): void => {
    if (batchTimer) {
      return;
    }
    batchTimer = setTimeout(flushBatch, FS_WATCH_BATCH_WINDOW_MS);
  };

  const enqueue = (change: FileSystemChange): void => {
    if (disposed) {
      return;
    }
    batch.push(change);
    if (batch.length >= FS_WATCH_MAX_BATCH_SIZE) {
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      flushBatch();
      return;
    }
    scheduleBatchFlush();
  };

  const markOmittedChange = (): void => {
    if (disposed) {
      return;
    }
    omittedChanges = true;
    scheduleBatchFlush();
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    flushBatch();
  };

  return { dispose, enqueue, markOmittedChange };
}
