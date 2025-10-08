import fs from 'node:fs';
import path from 'node:path';
import type { DirectoryHandle, FileSystemChange } from '../types';

export function startFsWatch(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  try {
    const native = fs.watch(handle.path, { recursive: false }, (ev, filename) => {
      if (!filename) return;
      const full = path.join(handle.path, filename);
      const exists = fs.existsSync(full);
      let isDir = false;
      if (exists) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
      }
      const type: FileSystemChange['type'] =
        ev === 'rename' ? (exists ? 'added' : 'removed') : 'modified';
      callback([{ type, path: full, kind: isDir ? 'directory' : 'file' }]);
    });
    return () => native.close();
  } catch (_e) {
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
    .on('error', (_error: unknown) => {});

  return () => watcher.close();
}

export function handleWatcherSetupError(
  err: unknown,
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  const e = err as NodeJS.ErrnoException;
  if (e?.code !== 'MODULE_NOT_FOUND') {
  }
  return startFsWatch(handle, callback);
}
