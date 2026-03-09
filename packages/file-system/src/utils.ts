import fsPromises from 'node:fs/promises';
import { AccessError, PermissionError } from './errors';
import { resolveValidatedPath } from './path-validation';

export {
  createLimiter,
  extractNativeDirectoryHandle,
  extractNativeDirectoryHandleAsNull,
  extractNativeDirectoryHandleAsUndefined,
  isFileSystemDirectoryHandle,
  isFileSystemFileHandle,
  isValidDirectoryHandle,
  normalizeDirectoryReadOptions,
} from './utils-browser';

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
