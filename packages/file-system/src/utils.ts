import type { DirectoryHandle } from './types';

/**
 * Extracts the native FileSystemDirectoryHandle from an adapter DirectoryHandle
 * This is useful for hooks that need to work with the native File System Access API
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

  // For electron or other platforms, we might need different handling
  // For now, throw an error to make it clear this is web-only
  // If platform is undefined, assume web for backward compatibility
  if (handle.platform === undefined) {
    console.warn('DirectoryHandle platform is undefined, assuming web platform');
    return handle._internal as FileSystemDirectoryHandle;
  }

  throw new Error(
    `extractNativeDirectoryHandle is only supported for web platform, got: ${handle.platform}`
  );
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
