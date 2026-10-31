import {
  FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT,
  type FileSystemChange,
  type FileSystemWatchBatchMetadata,
} from '@brainstrike/types';

// Shared change-batching primitive for the root watch engine
// (see ./root-watchers.ts).
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
  // Each distinct change once, at the position of its last occurrence: a path
  // that changes again within the window adds nothing new (BST-2372).
  let batch = new Map<string, FileSystemChange>();
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let filteredChangeBoundaries = new Set<string>();
  let filteredChangeBoundariesOverflow = false;

  const flushBatch = (): void => {
    batchTimer = null;
    if (batch.size > 0 || filteredChangeBoundaries.size > 0) {
      const changes = [...batch.values()];
      const metadata: FileSystemWatchBatchMetadata | undefined =
        filteredChangeBoundaries.size > 0
          ? {
              filteredChangeBoundaries: [...filteredChangeBoundaries],
              ...(filteredChangeBoundariesOverflow
                ? { filteredChangeBoundariesOverflow: true }
                : {}),
            }
          : undefined;
      batch = new Map();
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
    const identity = `${change.kind}\0${change.type}\0${change.path}`;
    batch.delete(identity);
    batch.set(identity, change);
    if (batch.size >= FS_WATCH_MAX_BATCH_SIZE) {
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
