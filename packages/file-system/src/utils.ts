import fsPromises from 'node:fs/promises';
import { AccessError, PermissionError } from './errors';
import type { DirectoryHandle } from './types';

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
    console.warn('DirectoryHandle platform is undefined, assuming web platform');
    return handle._internal as FileSystemDirectoryHandle;
  }

  // For non-web platforms, return null instead of throwing
  console.warn(
    `extractNativeDirectoryHandle called for ${handle.platform} platform, returning null. Consider using platform-agnostic file system operations instead.`
  );
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
  return handle != null && handle.kind === 'directory';
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
  try {
    const stats = await fsPromises.stat(path);
    if (!stats.isDirectory()) {
      throw new AccessError('Selected path is not a directory', path, 'access', assertFn);
    }
  } catch (error) {
    if (error instanceof AccessError) {
      throw error;
    }
    throw new PermissionError(
      `Cannot access selected directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
      assertFn
    );
  }
}
