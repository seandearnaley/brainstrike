import fsPromises from 'node:fs/promises';
import { AccessError, PermissionError } from './errors';
import { resolveValidatedPath } from './path-validation';
import type { DirectoryHandle, DirectoryReadOptions } from './types';

/**
 * Extracts the native FileSystemDirectoryHandle from an adapter DirectoryHandle
 * This is useful for hooks that need to work with the native File System Access API
 * For non-web platforms (like Electron), this returns null as there's no native handle
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

  // For electron or other platforms, return null since there's no native handle
  // If platform is undefined, assume web for backward compatibility
  if (handle.platform === undefined) {
    return handle._internal as FileSystemDirectoryHandle;
  }
  return null;
}

/**
 * Variant that returns undefined instead of null for better type compatibility
 */
export function extractNativeDirectoryHandleAsUndefined(
  handle: DirectoryHandle | null | undefined
): FileSystemDirectoryHandle | undefined {
  const result = extractNativeDirectoryHandle(handle);
  return result ?? undefined;
}

/**
 * Variant that returns null instead of undefined for better type compatibility
 */
export function extractNativeDirectoryHandleAsNull(
  handle: DirectoryHandle | null | undefined
): FileSystemDirectoryHandle | null {
  const result = extractNativeDirectoryHandle(handle);
  return result === undefined ? null : result;
}

/**
 * Type guard to check if we have a valid DirectoryHandle
 */
export function isValidDirectoryHandle(
  handle: DirectoryHandle | null | undefined
): handle is DirectoryHandle {
  return handle !== null && handle !== undefined && handle.kind === 'directory';
}

/**
 * Validate that a given path exists and is a directory.
 *
 * @throws {AccessError} If the path exists but is not a directory.
 * @throws {PermissionError} If the path cannot be accessed.
 */
export async function validateDirectoryPath(
  path: string,
  asserter?: (...args: unknown[]) => unknown
): Promise<void> {
  const assertFn = (asserter ?? validateDirectoryPath) as (...args: unknown[]) => unknown;
  const resolved = await resolveValidatedPath({
    requestedPath: path,
  });
  if (!resolved.ok) {
    throw new AccessError(
      `Invalid directory path: ${resolved.error.message}`,
      path,
      'access',
      assertFn
    );
  }
  try {
    const stats = await fsPromises.stat(resolved.path);
    if (!stats.isDirectory()) {
      throw new AccessError('Selected path is not a directory', resolved.path, 'access', assertFn);
    }
  } catch (error) {
    if (error instanceof AccessError) {
      throw error;
    }
    throw new PermissionError(
      `Cannot access selected directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      resolved.path,
      assertFn
    );
  }
}

/**
 * Concurrency limiter shared across adapters.
 * max <= 0 or non-finite means unlimited concurrency (no limiting).
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

/**
 * Normalize DirectoryReadOptions with safe defaults.
 * - includeMetadata defaults to true
 * - concurrency defaults to 64; <=0 or non-finite treated as unlimited
 */
export function normalizeDirectoryReadOptions(options?: DirectoryReadOptions) {
  const includeMetadata = options?.includeMetadata ?? true;
  const rawConcurrency = options?.concurrency ?? 64;
  const concurrency = Number.isFinite(rawConcurrency) ? Math.floor(rawConcurrency) : Number.NaN;
  const limiter = createLimiter(concurrency);
  return {
    includeMetadata,
    concurrency,
    limiter,
  };
}

// Type guards for Web File System Access API handles
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
