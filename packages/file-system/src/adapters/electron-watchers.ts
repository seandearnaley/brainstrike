import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import { fileFilter } from '@brainstrike/utils/path-filter';
import type { DirectoryHandle, FileSystemChange } from '../types';

const logger = createLogger('ElectronWatchers');
export const FS_WATCH_BATCH_WINDOW_MS = 150;
// Invariant: keep watcher event buffering bounded during bursty workloads.
export const FS_WATCH_MAX_BATCH_SIZE = 500;

interface FileSystemChangeBatcher {
  dispose: () => void;
  enqueue: (change: FileSystemChange) => void;
}

function createFileSystemChangeBatcher(
  callback: (changes: FileSystemChange[]) => void
): FileSystemChangeBatcher {
  let batch: FileSystemChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flushBatch = (): void => {
    batchTimer = null;
    if (batch.length > 0) {
      const changes = batch;
      batch = [];
      callback(changes);
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

  return { dispose, enqueue };
}

export function startFsWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  const batcher = createFileSystemChangeBatcher(callback);

  const processNativeEvent = async (
    ev: string,
    filename: string | Buffer | null
  ): Promise<void> => {
    if (!filename) {
      return;
    }
    const full = path.join(handle.path, filename.toString());
    if (fileFilter.shouldIgnorePath(full)) {
      return;
    }
    try {
      const stat = await fs.promises.stat(full);
      const type: FileSystemChange['type'] = ev === 'rename' ? 'added' : 'modified';
      batcher.enqueue({ kind: stat.isDirectory() ? 'directory' : 'file', path: full, type });
    } catch {
      // The native fallback cannot know whether a missing path was a file or
      // directory. Directory removal is the safe invalidation shape because it
      // deletes the same-path record plus any stale descendants.
      if (ev === 'rename') {
        batcher.enqueue({ kind: 'directory', path: full, type: 'removed' });
      }
    }
  };

  let nativeEventQueue = Promise.resolve();
  const enqueueNativeEvent = (ev: string, filename: string | Buffer | null): void => {
    nativeEventQueue = nativeEventQueue
      .then(() => processNativeEvent(ev, filename))
      .catch((error: unknown) => {
        logger.error('Native fs.watch event processing failed', { error, path: handle.path });
      });
  };

  try {
    // Node only supports recursive native fs.watch on macOS and Windows.
    // Unsupported platforms throw synchronously and are reported below as unwatched.
    const native = fs.watch(handle.path, { recursive: true }, enqueueNativeEvent);
    logger.warn('Using recursive native fs.watch fallback', {
      path: handle.path,
      platform: process.platform,
      recursiveSupport: 'macos-windows-only',
    });
    return () => {
      native.close();
      batcher.dispose();
    };
  } catch (error) {
    logger.error('Failed to start recursive native fs.watch; folder will not be watched', {
      error,
      path: handle.path,
      platform: process.platform,
      recursiveSupport: 'macos-windows-only',
    });
    return () => {};
  }
}

export async function startChokidarWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): Promise<() => void> {
  // Stryker disable next-line StringLiteral
  const mod = await import('chokidar');
  const chokidar: typeof import('chokidar') =
    // biome-ignore lint/suspicious/noExplicitAny: inter-op handling
    (mod as any).watch
      ? // biome-ignore lint/suspicious/noExplicitAny: inter-op handling
        (mod as any)
      : (mod.default as unknown as typeof import('chokidar'));

  const watcher = chokidar.watch(handle.path, {
    atomic: true,
    awaitWriteFinish: { pollInterval: 100, stabilityThreshold: 100 },
    followSymlinks: false,
    ignored: (filePath: string) => fileFilter.shouldIgnorePath(filePath),
    ignoreInitial: true,
    persistent: true,
  });

  const batcher = createFileSystemChangeBatcher(callback);
  const toChange = (type: FileSystemChange['type'], filePath: string, isDir: boolean) => {
    batcher.enqueue({ kind: isDir ? 'directory' : 'file', path: filePath, type });
  };

  watcher
    .on('add', (file: string) => toChange('added', file, false))
    .on('addDir', (dir: string) => toChange('added', dir, true))
    .on('change', (file: string) => toChange('modified', file, false))
    .on('unlink', (file: string) => toChange('removed', file, false))
    .on('unlinkDir', (dir: string) => toChange('removed', dir, true))
    .on('error', (error: unknown) => {
      logger.error('Chokidar watcher reported an error', { error, path: handle.path });
    });

  return () => {
    watcher.close();
    batcher.dispose();
  };
}

export function handleWatcherSetupError(
  err: unknown,
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  const e = err as NodeJS.ErrnoException;
  if (e?.code !== 'MODULE_NOT_FOUND') {
    logger.error('Failed to set up chokidar watcher, falling back to fs.watch', {
      error: err,
      path: handle.path,
    });
  }
  return startFsWatch(handle, callback);
}
