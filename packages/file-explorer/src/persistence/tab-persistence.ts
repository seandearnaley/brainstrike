/**
 * Tab File Handle Persistence (BST-307)
 *
 * This module provides functionality to restore file handles for open editor tabs
 * after the browser reloads. File handles are stored in IndexedDB via WebHandleCache
 * when files are read, and this module provides the restoration logic.
 *
 * Key concepts:
 * - Tab metadata (path, compositeKey) is stored in localStorage via TabManagerStore
 * - File handles are stored in IndexedDB via WebHandleCache (during readFile)
 * - On restore, we match persisted tabs with their stored file handles
 * - Each file may need individual permission if folder permission wasn't granted
 *
 * Chrome's permission model:
 * - If the root folder has granted permission, child files inherit it
 * - If not, each file needs explicit permission (user gesture required)
 * - queryPermission() can check without triggering a prompt
 */

import { createLogger, decodeFileSelection } from '@brainstrike/utils';

// Type declarations for File System Access API permission methods
// The browser's FileSystemFileHandle may have these methods, but TypeScript's
// lib.dom.d.ts doesn't include them. We use intersection types to access them safely.
interface FileSystemPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandlePermissions {
  queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
}

/** FileSystemFileHandle with optional permission methods */
type FileHandleWithPermissions = FileSystemFileHandle & FileSystemHandlePermissions;

const logger = createLogger('TabPersistence');

/** Status of a restored tab's file handle */
export type TabRestoreStatus =
  | 'restored' // File handle restored and accessible
  | 'needs-permission' // Handle exists but needs user permission
  | 'not-found' // Handle not found in IndexedDB or file deleted
  | 'pending'; // Not yet attempted to restore

/** Information about a tab being restored */
export interface TabRestoreInfo {
  /** Tab ID (unique per session) */
  tabId: string;
  /** Composite key encoding folderId and path */
  compositeKey: string;
  /** File path relative to root folder */
  path: string;
  /** Root folder ID this file belongs to */
  folderId: string;
  /** Current restoration status */
  status: TabRestoreStatus;
  /** The file handle if restored, null otherwise */
  handle: FileSystemFileHandle | null;
  /** Error message if restoration failed */
  error?: string;
}

/** Result of attempting to restore all tabs */
export interface TabRestoreResult {
  /** Tabs that were successfully restored */
  restored: TabRestoreInfo[];
  /** Tabs that need user permission */
  needsPermission: TabRestoreInfo[];
  /** Tabs whose files were not found */
  notFound: TabRestoreInfo[];
}

/** Interface for the file handle cache (matches WebHandleCache) */
export interface FileHandleCache {
  getFileHandle(folderId: string, relativePath: string): Promise<FileSystemFileHandle | null>;
  removeFileHandle(folderId: string, relativePath: string): Promise<void>;
}

/**
 * Check if a FileSystemFileHandle is valid (has required methods).
 */
function isValidFileHandle(handle: unknown): handle is FileSystemFileHandle {
  if (!handle || typeof handle !== 'object') {
    return false;
  }
  const candidate = handle as Record<string, unknown>;
  return (
    candidate['kind'] === 'file' &&
    typeof candidate['name'] === 'string' &&
    'getFile' in candidate &&
    typeof candidate['getFile'] === 'function'
  );
}

/**
 * Query the permission state of a file handle without requesting permission.
 * Returns 'granted', 'denied', 'prompt', or 'unknown'.
 */
async function queryFilePermission(
  handle: FileSystemFileHandle
): Promise<PermissionState | 'unknown'> {
  // Cast to access optional permission methods not in standard TypeScript types
  const handleWithPerms = handle as FileHandleWithPermissions;

  if (typeof handleWithPerms.queryPermission !== 'function') {
    // Browser doesn't support queryPermission, assume we need to try
    return 'unknown';
  }

  try {
    return await handleWithPerms.queryPermission({ mode: 'read' });
  } catch (err) {
    logger.debug('queryFilePermission failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unknown';
  }
}

/**
 * Verify a file handle is still accessible by attempting to get the file.
 * This is more reliable than queryPermission for detecting deleted files.
 */
async function verifyFileHandle(handle: FileSystemFileHandle): Promise<boolean> {
  try {
    // getFile() will throw if the file no longer exists or isn't accessible
    await handle.getFile();
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to restore a single tab's file handle from the cache.
 *
 * @param tabId - The tab's unique ID
 * @param compositeKey - The composite key encoding folderId and path
 * @param handleCache - The file handle cache to retrieve from
 * @returns TabRestoreInfo with the restoration status
 */
export async function restoreTabFileHandle(
  tabId: string,
  compositeKey: string,
  handleCache: FileHandleCache
): Promise<TabRestoreInfo> {
  // Wrap decodeFileSelection in try/catch to handle corrupted/legacy composite keys
  let folderId: string;
  let path: string;

  try {
    const decoded = decodeFileSelection(compositeKey);
    folderId = decoded.folderId;
    path = decoded.path;
  } catch (err) {
    logger.warn('restoreTabFileHandle: failed to decode compositeKey', {
      compositeKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      tabId,
      compositeKey,
      path: '',
      folderId: '',
      status: 'not-found',
      handle: null,
      error: 'Invalid composite key',
    };
  }

  if (!(folderId && path)) {
    logger.warn('restoreTabFileHandle: invalid compositeKey', { compositeKey });
    return {
      tabId,
      compositeKey,
      path: path || '',
      folderId: folderId || '',
      status: 'not-found',
      handle: null,
      error: 'Invalid composite key',
    };
  }

  try {
    // Retrieve the file handle from IndexedDB
    const handle = await handleCache.getFileHandle(folderId, path);

    if (!handle) {
      logger.debug('restoreTabFileHandle: handle not found', { folderId, path });
      return {
        tabId,
        compositeKey,
        path,
        folderId,
        status: 'not-found',
        handle: null,
      };
    }

    // Validate the handle shape
    if (!isValidFileHandle(handle)) {
      logger.warn('restoreTabFileHandle: invalid handle shape', { folderId, path });
      await handleCache.removeFileHandle(folderId, path);
      return {
        tabId,
        compositeKey,
        path,
        folderId,
        status: 'not-found',
        handle: null,
        error: 'Corrupted handle in cache',
      };
    }

    // Check permission state
    const permissionState = await queryFilePermission(handle);

    if (permissionState === 'granted') {
      // Double-check the file is actually accessible
      const isAccessible = await verifyFileHandle(handle);
      if (isAccessible) {
        logger.debug('restoreTabFileHandle: restored successfully', { folderId, path });
        return {
          tabId,
          compositeKey,
          path,
          folderId,
          status: 'restored',
          handle,
        };
      }
      // File was deleted or moved
      logger.info('restoreTabFileHandle: file no longer accessible', { folderId, path });
      await handleCache.removeFileHandle(folderId, path);
      return {
        tabId,
        compositeKey,
        path,
        folderId,
        status: 'not-found',
        handle: null,
        error: 'File no longer exists',
      };
    }

    if (permissionState === 'denied') {
      // Permission explicitly denied - still return the handle so UI can offer retry
      return {
        tabId,
        compositeKey,
        path,
        folderId,
        status: 'needs-permission',
        handle,
        error: 'Permission denied',
      };
    }

    // Permission is 'prompt' or 'unknown' - return handle for UI to request permission
    return {
      tabId,
      compositeKey,
      path,
      folderId,
      status: 'needs-permission',
      handle,
    };
  } catch (err) {
    logger.warn('restoreTabFileHandle: error during restoration', {
      folderId,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      tabId,
      compositeKey,
      path,
      folderId,
      status: 'not-found',
      handle: null,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Attempt to restore all provided tabs' file handles.
 *
 * @param tabs - Array of tab info (tabId and compositeKey)
 * @param handleCache - The file handle cache to retrieve from
 * @returns Categorized results of the restoration attempt
 */
export async function restoreAllTabFileHandles(
  tabs: Array<{ tabId: string; compositeKey: string }>,
  handleCache: FileHandleCache
): Promise<TabRestoreResult> {
  const result: TabRestoreResult = {
    restored: [],
    needsPermission: [],
    notFound: [],
  };

  // Process tabs in parallel for better performance
  const restorePromises = tabs.map(({ tabId, compositeKey }) =>
    restoreTabFileHandle(tabId, compositeKey, handleCache)
  );

  const restoreResults = await Promise.allSettled(restorePromises);

  for (const settledResult of restoreResults) {
    if (settledResult.status === 'rejected') {
      // This shouldn't happen since restoreTabFileHandle catches errors
      logger.warn('restoreAllTabFileHandles: unexpected rejection', {
        error: settledResult.reason,
      });
      continue;
    }

    const info = settledResult.value;
    switch (info.status) {
      case 'restored':
        result.restored.push(info);
        break;
      case 'needs-permission':
        result.needsPermission.push(info);
        break;
      case 'not-found':
        result.notFound.push(info);
        break;
      // 'pending' should not occur after restore attempt
    }
  }

  logger.info('restoreAllTabFileHandles: completed', {
    restored: result.restored.length,
    needsPermission: result.needsPermission.length,
    notFound: result.notFound.length,
  });

  return result;
}

/**
 * Request permission for a file handle. Must be called from a user gesture handler.
 *
 * @param handle - The file handle to request permission for
 * @returns Promise resolving to whether permission was granted
 */
export async function requestFilePermission(handle: FileSystemFileHandle): Promise<boolean> {
  // Cast to access optional permission methods not in standard TypeScript types
  const handleWithPerms = handle as FileHandleWithPermissions;

  if (typeof handleWithPerms.requestPermission !== 'function') {
    logger.warn('requestFilePermission: browser does not support requestPermission');
    return false;
  }

  try {
    const result = await handleWithPerms.requestPermission({ mode: 'read' });
    return result === 'granted';
  } catch (err) {
    const errorName = err instanceof Error ? err.name : '';

    // AbortError means user cancelled - not a real error
    if (errorName === 'AbortError') {
      logger.debug('requestFilePermission: user cancelled');
      return false;
    }

    // NotFoundError means the file no longer exists
    if (errorName === 'NotFoundError') {
      logger.info('requestFilePermission: file no longer exists');
      return false;
    }

    logger.warn('requestFilePermission: error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Check if the browser supports the File System Access API file handle features.
 */
export function isFileHandlePersistenceSupported(): boolean {
  if (typeof FileSystemFileHandle === 'undefined') {
    return false;
  }
  // Cast prototype to check for optional permission method
  const proto = FileSystemFileHandle.prototype as FileSystemHandlePermissions;
  return typeof proto.queryPermission === 'function';
}
