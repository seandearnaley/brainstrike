import {
  FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT,
  type FileSystemChange,
  type FileSystemWatchBatchMetadata,
} from '../types.js';

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
  markFilteredChangeBoundary: (boundary: string) => void;
}

export function createFileSystemChangeBatcher(
  callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void
): FileSystemChangeBatcher {
  let batch: FileSystemChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let filteredChangeBoundaries = new Set<string>();
  let filteredChangeBoundariesOverflow = false;

  const flushBatch = (): void => {
    batchTimer = null;
    if (batch.length > 0 || filteredChangeBoundaries.size > 0) {
      const changes = batch;
      const metadata: FileSystemWatchBatchMetadata | undefined =
        filteredChangeBoundaries.size > 0
          ? {
              filteredChangeBoundaries: [...filteredChangeBoundaries],
              ...(filteredChangeBoundariesOverflow
                ? { filteredChangeBoundariesOverflow: true }
                : {}),
            }
          : undefined;
      batch = [];
      filteredChangeBoundaries = new Set();
      filteredChangeBoundariesOverflow = false;
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

  const markFilteredChangeBoundary = (boundary: string): void => {
    if (disposed) {
      return;
    }
    const boundarySegments = boundary.split('/');
    if (
      boundary.length === 0 ||
      boundary.startsWith('/') ||
      /^[A-Za-z]:\//u.test(boundary) ||
      boundary.includes('\\') ||
      boundarySegments.some(
        (segment) => segment.length === 0 || segment === '.' || segment === '..'
      )
    ) {
      throw new Error(
        `Filtered watcher boundary must be a normalized root-relative path: ${boundary}`
      );
    }
    if (filteredChangeBoundaries.has(boundary)) {
      scheduleBatchFlush();
      return;
    }
    if (filteredChangeBoundaries.size >= FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT) {
      filteredChangeBoundariesOverflow = true;
      scheduleBatchFlush();
      return;
    }
    filteredChangeBoundaries.add(boundary);
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

  return { dispose, enqueue, markFilteredChangeBoundary };
}
