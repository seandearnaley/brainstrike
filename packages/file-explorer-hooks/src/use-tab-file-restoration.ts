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
 */

import {
  type FileHandleCache,
  requestFilePermission,
  restoreAllTabFileHandles,
  type TabRestoreStatus,
} from '@brainstrike/file-explorer';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const logger = createLogger('useTabFileRestoration');

/** Delay before attempting restoration to allow Zustand to hydrate */
const RESTORATION_DELAY_MS = 300;

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
  // Track handles for permission requests
  const handlesRef = useRef<Map<string, FileSystemFileHandle>>(new Map());

  // Get handle cache from adapter (web platform only)
  const handleCache = useMemo(() => {
    const adapter = fileSystemAdapter as WebAdapterWithCache | null;
    return adapter?.getHandleCache?.() ?? null;
  }, [fileSystemAdapter]);

  // Restore tabs that haven't been attempted yet
  const restoreTabs = useCallback(
    async (tabsToRestore: Array<{ tabId: string; compositeKey: string }>) => {
      if (!handleCache || tabsToRestore.length === 0) {
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

        const result = await restoreAllTabFileHandles(
          newTabs.map((t) => ({ tabId: t.tabId, compositeKey: t.compositeKey })),
          handleCache
        );

        // Store handles from restoration results
        const storeHandle = (compositeKey: string, handle: FileSystemFileHandle | null) => {
          if (handle) {
            handlesRef.current.set(compositeKey, handle);
          }
        };

        // Notify for tabs whose files weren't found
        for (const info of result.notFound) {
          const tab = newTabs.find((t) => t.compositeKey === info.compositeKey);
          if (tab && onTabNotFound) {
            onTabNotFound(tab.tabId);
          }
        }

        // Update statuses map
        setTabStatuses((prev) => {
          const next = new Map(prev);

          for (const info of result.restored) {
            next.set(info.compositeKey, createTabFileStatus(info.compositeKey, 'restored'));
            storeHandle(info.compositeKey, info.handle);
          }

          for (const info of result.needsPermission) {
            next.set(
              info.compositeKey,
              createTabFileStatus(info.compositeKey, 'needs-permission', info.error)
            );
            storeHandle(info.compositeKey, info.handle);
          }

          for (const info of result.notFound) {
            next.set(
              info.compositeKey,
              createTabFileStatus(info.compositeKey, 'not-found', info.error)
            );
          }

          return next;
        });

        logger.info('Tab restoration completed', {
          restored: result.restored.length,
          needsPermission: result.needsPermission.length,
          notFound: result.notFound.length,
        });
      } catch (err) {
        logger.warn('Tab restoration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setIsRestoring(false);
      }
    },
    [handleCache, onTabNotFound]
  );

  // Auto-restore tabs on mount/when tabs change
  useEffect(() => {
    if (!handleCache || tabs.length === 0) {
      return;
    }

    // Check if any tabs need restoration
    const tabsNeedingRestore = tabs.filter((tab) => !restoredTabsRef.current.has(tab.compositeKey));

    if (tabsNeedingRestore.length === 0) {
      return;
    }

    // Delay to allow Zustand hydration to complete
    const timer = setTimeout(() => {
      void restoreTabs(
        tabsNeedingRestore.map((t) => ({ tabId: t.id, compositeKey: t.compositeKey }))
      );
    }, RESTORATION_DELAY_MS);

    return () => clearTimeout(timer);
  }, [handleCache, tabs, restoreTabs]);

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

  // Request permission for a specific tab
  const requestTabPermission = useCallback(async (compositeKey: string): Promise<boolean> => {
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
  }, []);

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
