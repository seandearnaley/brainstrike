/**
 * Hook for restoring file handles for persisted editor tabs (BST-307)
 *
 * This hook integrates with the tab manager and file handle cache to restore
 * file handles for tabs that were persisted across browser reloads.
 *
 * Key behaviors:
 * - Automatically attempts restoration when tabs are loaded from storage
 * - Tracks restoration status per-tab for UI display
 * - Provides function to request permission for tabs that need it
 * - Cleans up stale tab entries when files no longer exist
 * - Platform-aware: Works differently on web (IndexedDB handles) vs desktop (direct file paths)
 */

import {
  type FileHandleCache,
  requestFilePermission,
  restoreAllTabFileHandles,
  type TabRestoreStatus,
} from '@brainstrike/file-explorer';
import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { createLogger, decodeFileSelection } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const logger = createLogger('useTabFileRestoration');

/** Delay before attempting restoration to allow Zustand to hydrate */
const RESTORATION_DELAY_MS = 300;

/**
 * Check if a relative path is safe (no path traversal).
 * Returns false if the path contains '..' segments that could escape the root.
 */
function isPathSafe(relativePath: string): boolean {
  // Normalize path separators and split into segments
  const segments = relativePath.split(/[\\/]/);

  // Track depth - going negative means we've escaped the root
  let depth = 0;
  for (const segment of segments) {
    if (segment === '..') {
      depth--;
      if (depth < 0) {
        return false;
      }
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }

  return true;
}

/** Status information for a tab's file handle */
export interface TabFileStatus {
  compositeKey: string;
  status: TabRestoreStatus;
  error?: string | undefined;
}

/** Helper to create TabFileStatus with optional error */
function createTabFileStatus(
  compositeKey: string,
  status: TabRestoreStatus,
  error?: string
): TabFileStatus {
  const result: TabFileStatus = { compositeKey, status };
  if (error !== undefined) {
    result.error = error;
  }
  return result;
}

/** Return type for the hook */
export interface UseTabFileRestorationReturn {
  /** Whether restoration is currently in progress */
  isRestoring: boolean;
  /** Map of composite key to restoration status */
  tabStatuses: Map<string, TabFileStatus>;
  /** Request permission for a specific tab (must be called from click handler) */
  requestTabPermission: (compositeKey: string) => Promise<boolean>;
  /** Manually trigger restoration for tabs */
  restoreTabs: (tabs: Array<{ tabId: string; compositeKey: string }>) => Promise<void>;
  /** Check if a tab needs user action (permission or removal) */
  needsUserAction: (compositeKey: string) => boolean;
  /** Get display message for tab status */
  getStatusMessage: (compositeKey: string) => string | null;
}

/** Shape of file system adapter with handle cache access */
interface WebAdapterWithCache {
  getHandleCache?: () => FileHandleCache;
}

/** Shape of file system adapter with exists method (Electron) */
interface AdapterWithExists {
  exists?: (path: string) => Promise<boolean>;
}

/** Result of Electron tab restoration */
interface ElectronRestoreResult {
  restored: Array<{ compositeKey: string }>;
  notFound: Array<{ compositeKey: string; error: string }>;
}

/**
 * Restore tabs on Electron by checking if files exist directly.
 * No permission handling needed - Electron has full file system access.
 */
async function restoreElectronTabs(
  tabsToRestore: Array<{ tabId: string; compositeKey: string }>,
  adapter: AdapterWithExists,
  onTabNotFound?: (tabId: string) => void
): Promise<ElectronRestoreResult> {
  const restored: Array<{ compositeKey: string }> = [];
  const notFound: Array<{ compositeKey: string; error: string }> = [];

  // Process tabs in parallel
  await Promise.all(
    tabsToRestore.map(async (tab) => {
      try {
        // Decode the composite key to get folder ID (which is the root path on Electron) and relative path
        const { folderId, path: relativePath } = decodeFileSelection(tab.compositeKey);

        if (!(folderId && relativePath)) {
          notFound.push({ compositeKey: tab.compositeKey, error: 'Invalid composite key' });
          onTabNotFound?.(tab.tabId);
          return;
        }

        // Security: Validate path doesn't contain traversal sequences
        if (!isPathSafe(relativePath)) {
          logger.warn('restoreElectronTabs: path traversal detected', { relativePath });
          notFound.push({
            compositeKey: tab.compositeKey,
            error: 'Invalid path: traversal not allowed',
          });
          onTabNotFound?.(tab.tabId);
          return;
        }

        // On Electron, folderId is typically the root folder path
        // Construct full path: rootPath + relativePath
        const fullPath = `${folderId}/${relativePath}`;

        // Check if file exists using the adapter
        const exists = adapter.exists ? await adapter.exists(fullPath) : false;

        if (exists) {
          restored.push({ compositeKey: tab.compositeKey });
        } else {
          notFound.push({ compositeKey: tab.compositeKey, error: 'File no longer exists' });
          onTabNotFound?.(tab.tabId);
        }
      } catch (err) {
        notFound.push({
          compositeKey: tab.compositeKey,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
        onTabNotFound?.(tab.tabId);
      }
    })
  );

  return { restored, notFound };
}

/** Update tab statuses from Electron restoration result */
function updateStatusesFromElectronResult(
  prev: Map<string, TabFileStatus>,
  result: ElectronRestoreResult
): Map<string, TabFileStatus> {
  const next = new Map(prev);

  for (const info of result.restored) {
    next.set(info.compositeKey, createTabFileStatus(info.compositeKey, 'restored'));
  }

  for (const info of result.notFound) {
    next.set(info.compositeKey, createTabFileStatus(info.compositeKey, 'not-found', info.error));
  }

  return next;
}

/** Store handle in ref map if present */
function storeHandleIfPresent(
  handlesRef: React.RefObject<Map<string, FileSystemFileHandle>>,
  compositeKey: string,
  handle: FileSystemFileHandle | null
): void {
  if (handle && handlesRef.current) {
    handlesRef.current.set(compositeKey, handle);
  }
}

/**
 * Hook to manage file handle restoration for editor tabs.
 *
 * @param tabs - Current tabs from the tab manager store
 * @param onTabNotFound - Callback when a tab's file can't be restored (for cleanup)
 */
export function useTabFileRestoration(
  tabs: Array<{ id: string; compositeKey: string }>,
  onTabNotFound?: (tabId: string) => void
): UseTabFileRestorationReturn {
  const { fileSystemAdapter } = useAdapters();
  const [isRestoring, setIsRestoring] = useState(false);
  const [tabStatuses, setTabStatuses] = useState<Map<string, TabFileStatus>>(new Map());

  // Track which tabs we've already attempted to restore
  const restoredTabsRef = useRef<Set<string>>(new Set());
  // Track handles for permission requests (web platform only)
  const handlesRef = useRef<Map<string, FileSystemFileHandle>>(new Map());

  // Detect platform once
  const platform = useMemo<Platform>(() => detectPlatform(), []);

  // Get handle cache from adapter (web platform only)
  const handleCache = useMemo(() => {
    if (platform !== 'web') {
      return null;
    }
    const adapter = fileSystemAdapter as WebAdapterWithCache | null;
    return adapter?.getHandleCache?.() ?? null;
  }, [fileSystemAdapter, platform]);

  // Handle Electron restoration
  const restoreElectronTabsWithStatus = useCallback(
    async (newTabs: Array<{ tabId: string; compositeKey: string }>) => {
      const adapter = fileSystemAdapter as AdapterWithExists | null;
      if (!adapter?.exists) {
        logger.warn('Electron adapter missing exists method');
        return;
      }

      const result = await restoreElectronTabs(newTabs, adapter, onTabNotFound);
      setTabStatuses((prev) => updateStatusesFromElectronResult(prev, result));

      logger.info('Tab restoration completed (Electron)', {
        restored: result.restored.length,
        notFound: result.notFound.length,
      });
    },
    [fileSystemAdapter, onTabNotFound]
  );

  // Handle Web restoration
  const restoreWebTabsWithStatus = useCallback(
    async (newTabs: Array<{ tabId: string; compositeKey: string }>) => {
      if (!handleCache) {
        logger.warn('Web platform but no handle cache available');
        return;
      }

      const result = await restoreAllTabFileHandles(
        newTabs.map((t) => ({ tabId: t.tabId, compositeKey: t.compositeKey })),
        handleCache
      );

      // Notify for tabs whose files weren't found
      for (const info of result.notFound) {
        const tab = newTabs.find((t) => t.compositeKey === info.compositeKey);
        if (tab && onTabNotFound) {
          onTabNotFound(tab.tabId);
        }
      }

      // Store handles first (side effect - must be outside state updater)
      for (const info of result.restored) {
        storeHandleIfPresent(handlesRef, info.compositeKey, info.handle);
      }
      for (const info of result.needsPermission) {
        storeHandleIfPresent(handlesRef, info.compositeKey, info.handle);
      }

      // Update statuses map (pure function)
      setTabStatuses((prev) => {
        const next = new Map(prev);

        for (const info of result.restored) {
          next.set(info.compositeKey, createTabFileStatus(info.compositeKey, 'restored'));
        }

        for (const info of result.needsPermission) {
          next.set(
            info.compositeKey,
            createTabFileStatus(info.compositeKey, 'needs-permission', info.error)
          );
        }

        for (const info of result.notFound) {
          next.set(
            info.compositeKey,
            createTabFileStatus(info.compositeKey, 'not-found', info.error)
          );
        }

        return next;
      });

      logger.info('Tab restoration completed (Web)', {
        restored: result.restored.length,
        needsPermission: result.needsPermission.length,
        notFound: result.notFound.length,
      });
    },
    [handleCache, onTabNotFound]
  );

  // Restore tabs that haven't been attempted yet
  const restoreTabs = useCallback(
    async (tabsToRestore: Array<{ tabId: string; compositeKey: string }>) => {
      if (tabsToRestore.length === 0) {
        return;
      }

      // Filter to only tabs we haven't attempted yet
      const newTabs = tabsToRestore.filter((tab) => !restoredTabsRef.current.has(tab.compositeKey));

      if (newTabs.length === 0) {
        return;
      }

      setIsRestoring(true);

      try {
        // Mark as attempted
        for (const tab of newTabs) {
          restoredTabsRef.current.add(tab.compositeKey);
        }

        // Platform-specific restoration
        if (platform === 'electron') {
          await restoreElectronTabsWithStatus(newTabs);
        } else {
          await restoreWebTabsWithStatus(newTabs);
        }
      } catch (err) {
        logger.warn('Tab restoration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIsRestoring(false);
      }
    },
    [platform, restoreElectronTabsWithStatus, restoreWebTabsWithStatus]
  );

  // Store restoreTabs in a ref to avoid useEffect re-running when callback changes
  const restoreTabsRef = useRef(restoreTabs);
  restoreTabsRef.current = restoreTabs;

  // Auto-restore tabs on mount/when tabs change
  useEffect(() => {
    // On web, we need the handle cache; on Electron, we need the adapter
    if (platform === 'web' && !handleCache) {
      return;
    }
    if (platform === 'electron' && !fileSystemAdapter) {
      return;
    }
    if (tabs.length === 0) {
      return;
    }

    // Check if any tabs need restoration
    const tabsNeedingRestore = tabs.filter((tab) => !restoredTabsRef.current.has(tab.compositeKey));

    if (tabsNeedingRestore.length === 0) {
      return;
    }

    // Delay to allow Zustand hydration to complete
    const timer = setTimeout(() => {
      void restoreTabsRef.current(
        tabsNeedingRestore.map((t) => ({ tabId: t.id, compositeKey: t.compositeKey }))
      );
    }, RESTORATION_DELAY_MS);

    return () => clearTimeout(timer);
  }, [platform, handleCache, fileSystemAdapter, tabs]);

  // Clean up in-memory state when tabs are closed
  // Note: We don't remove file handles from IndexedDB - LRU eviction handles that
  // biome-ignore lint/plugin: This effect cleans up refs, not data fetching
  useEffect(() => {
    const currentKeys = new Set(tabs.map((t) => t.compositeKey));

    // Clean up handles and statuses for closed tabs
    for (const key of handlesRef.current.keys()) {
      if (!currentKeys.has(key)) {
        handlesRef.current.delete(key);
        restoredTabsRef.current.delete(key);
      }
    }

    // Clean up statuses map
    setTabStatuses((prev) => {
      let hasChanges = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!currentKeys.has(key)) {
          next.delete(key);
          hasChanges = true;
        }
      }
      return hasChanges ? next : prev;
    });
  }, [tabs]);

  // Request permission for a specific tab (web platform only)
  const requestTabPermission = useCallback(
    async (compositeKey: string): Promise<boolean> => {
      // On Electron, permission is always granted
      if (platform === 'electron') {
        return true;
      }

      const handle = handlesRef.current.get(compositeKey);
      if (!handle) {
        logger.warn('requestTabPermission: no handle for tab', { compositeKey });
        return false;
      }

      const granted = await requestFilePermission(handle);

      if (granted) {
        setTabStatuses((prev) => {
          const next = new Map(prev);
          next.set(compositeKey, createTabFileStatus(compositeKey, 'restored'));
          return next;
        });
      }

      return granted;
    },
    [platform]
  );

  // Check if a tab needs user action
  const needsUserAction = useCallback(
    (compositeKey: string): boolean => {
      const status = tabStatuses.get(compositeKey);
      return status?.status === 'needs-permission' || status?.status === 'not-found';
    },
    [tabStatuses]
  );

  // Get display message for tab status
  const getStatusMessage = useCallback(
    (compositeKey: string): string | null => {
      const status = tabStatuses.get(compositeKey);
      if (!status) {
        return null;
      }

      switch (status.status) {
        case 'needs-permission':
          return 'Click to restore access';
        case 'not-found':
          return status.error || 'File no longer available';
        default:
          return null;
      }
    },
    [tabStatuses]
  );

  return {
    isRestoring,
    tabStatuses,
    requestTabPermission,
    restoreTabs,
    needsUserAction,
    getStatusMessage,
  };
}
