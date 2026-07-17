import type { DirectoryHandle, DirectoryReadOptions } from './types';

/**
 * Extracts the native FileSystemDirectoryHandle from an adapter DirectoryHandle.
 * For non-web platforms (like Electron), this returns null.
 */
export function extractNativeDirectoryHandle(
  handle: DirectoryHandle | null | undefined
): FileSystemDirectoryHandle | null | undefined {
  if (!handle) {
    return handle as null | undefined;
  }

  if (handle.platform === 'web') {
    return handle._internal as FileSystemDirectoryHandle;
  }

  if (handle.platform === undefined) {
    return handle._internal as FileSystemDirectoryHandle;
  }
  return null;
}

export function extractNativeDirectoryHandleAsUndefined(
  handle: DirectoryHandle | null | undefined
): FileSystemDirectoryHandle | undefined {
  const result = extractNativeDirectoryHandle(handle);
  return result ?? undefined;
}

export function extractNativeDirectoryHandleAsNull(
  handle: DirectoryHandle | null | undefined
): FileSystemDirectoryHandle | null {
  const result = extractNativeDirectoryHandle(handle);
  return result === undefined ? null : result;
}

export function isValidDirectoryHandle(
  handle: DirectoryHandle | null | undefined
): handle is DirectoryHandle {
  return handle !== null && handle !== undefined && handle.kind === 'directory';
}

/**
 * Concurrency limiter shared across adapters.
 * max <= 0 or non-finite means unlimited concurrency.
 */
export function createLimiter(max: number) {
  if (!Number.isFinite(max) || max <= 0) {
    return async <T>(task: () => Promise<T>): Promise<T> => task();
  }
  let active = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };
      if (active < max) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

export function normalizeDirectoryReadOptions(options?: DirectoryReadOptions) {
  const includeMetadata = options?.includeMetadata ?? true;
  const rawConcurrency = options?.concurrency ?? 64;
  const concurrency = Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : Number.NaN;
  const limiter = createLimiter(concurrency);
  return {
    concurrency,
    includeMetadata,
    limiter,
  };
}

export function isFileSystemDirectoryHandle(h: unknown): h is FileSystemDirectoryHandle {
  return (
    !!h &&
    typeof h === 'object' &&
    (h as { kind?: unknown }).kind === 'directory' &&
    typeof (h as { name?: unknown }).name === 'string' &&
    'entries' in (h as object)
  );
}

export function isFileSystemFileHandle(h: unknown): h is FileSystemFileHandle {
  return (
    !!h &&
    typeof h === 'object' &&
    (h as { kind?: unknown }).kind === 'file' &&
    typeof (h as { name?: unknown }).name === 'string' &&
    'getFile' in (h as object)
  );
}
