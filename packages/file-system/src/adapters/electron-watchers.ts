import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import type { DirectoryHandle, FileSystemChange } from '../types';

const logger = createLogger('ElectronWatchers');
export const FS_WATCH_BATCH_WINDOW_MS = 150;
// Invariant: keep watcher event buffering bounded during bursty workloads.
export const FS_WATCH_MAX_BATCH_SIZE = 500;

export function startFsWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  let batch: FileSystemChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

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

  const enqueueChange = (change: FileSystemChange): void => {
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

  try {
    const native = fs.watch(handle.path, { recursive: false }, (ev, filename) => {
      if (!filename) {
        return;
      }
      const full = path.join(handle.path, filename);
      fs.promises.stat(full).then(
        (stat) => {
          const type: FileSystemChange['type'] = ev === 'rename' ? 'added' : 'modified';
          enqueueChange({ type, path: full, kind: stat.isDirectory() ? 'directory' : 'file' });
        },
        () => {
          // stat failed — file was likely removed
          if (ev === 'rename') {
            enqueueChange({ type: 'removed', path: full, kind: 'file' });
          }
        }
      );
    });
    return () => {
      native.close();
      if (batchTimer) {
        clearTimeout(batchTimer);
      }
      flushBatch();
    };
  } catch (error) {
    logger.error('Failed to start native fs.watch', { error, path: handle.path });
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
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
    ignored: /(^|[/\\])\../,
    depth: 0,
  });

  const toChange = (type: FileSystemChange['type'], filePath: string, isDir: boolean) => {
    callback([{ type, path: filePath, kind: isDir ? 'directory' : 'file' }]);
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

  return () => watcher.close();
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
