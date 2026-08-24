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
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { extractPathSegments } from '@brainstrike/utils/path-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readHandleCache } from './adapter-with-handle-cache.js';
import { useAdapters } from './adapters-context.js';

const logger = createLogger('useTabFileRestoration');

/** Delay before attempting restoration to allow Zustand to hydrate */
const RESTORATION_DELAY_MS = 300;

/** Maximum concurrent file existence checks for Electron (prevents filesystem overload) */
const ELECTRON_RESTORE_CONCURRENCY = 10;

/** Circuit breaker state for tracking failures */
interface CircuitBreakerState {
  failures: number;
  isOpen: boolean;
  lastFailureTime: number;
}

/** Circuit breaker configuration */
const CIRCUIT_BREAKER_THRESHOLD = 5; // Number of failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30_000; // Time before attempting to close circuit

const FILE_HANDLE_CACHE_METHODS = [
  'getFileHandle',
  'removeFileHandle',
] as const satisfies readonly (keyof FileHandleCache)[];
type UncoveredFileHandleCacheMethod = Exclude<
  keyof FileHandleCache,
  (typeof FILE_HANDLE_CACHE_METHODS)[number]
>;
const FILE_HANDLE_CACHE_METHODS_ARE_EXHAUSTIVE: UncoveredFileHandleCacheMethod extends never
  ? true
  : never = true;

function isFileHandleCache(value: unknown): value is FileHandleCache {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    FILE_HANDLE_CACHE_METHODS_ARE_EXHAUSTIVE &&
    FILE_HANDLE_CACHE_METHODS.every((method) => typeof candidate[method] === 'function')
  );
}

/**
 * Concurrency limiter with circuit breaker pattern.
 * Limits concurrent executions to prevent overwhelming the filesystem
 * and stops processing entirely if too many failures occur.
 */
function createConcurrencyLimiter(maxConcurrent: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  const circuitBreaker: CircuitBreakerState = {
    failures: 0,
    isOpen: false,
    lastFailureTime: 0,
  };

  const checkCircuitBreaker = (): boolean => {
    if (!circuitBreaker.isOpen) {
      return false;
    }
    // Check if enough time has passed to try again (half-open state)
    const timeSinceFailure = Date.now() - circuitBreaker.lastFailureTime;
    if (timeSinceFailure >= CIRCUIT_BREAKER_RESET_MS) {
      // Allow one request through to test if system is healthy
      circuitBreaker.isOpen = false;
      circuitBreaker.failures = 0;
      return false;
    }
    return true;
  };

  const recordSuccess = () => {
    // Reset failure count on success
    circuitBreaker.failures = 0;
  };

  const recordFailure = () => {
    circuitBreaker.failures++;
    circuitBreaker.lastFailureTime = Date.now();
    if (circuitBreaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitBreaker.isOpen = true;
      logger.warn('Circuit breaker opened due to repeated failures', {
        failures: circuitBreaker.failures,
      });
    }
  };

  const tryRun = () => {
    while (running < maxConcurrent && queue.length > 0 && !checkCircuitBreaker()) {
      running++;
      const next = queue.shift();
      next?.();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // Fast-fail if circuit is open
    if (checkCircuitBreaker()) {
      return Promise.reject(new Error('Circuit breaker is open - too many failures'));
    }

    return new Promise((resolve, reject) => {
      const run = () => {
        fn()
          .then((result) => {
            recordSuccess();
            resolve(result);
          })
          .catch((error: unknown) => {
            recordFailure();
            reject(error);
          })
          .finally(() => {
            running--;
            tryRun();
          });
      };

      queue.push(run);
      tryRun();
    });
  };
}

/**
 * Check if a relative path is safe (no path traversal or malicious content).
 * Returns false if the path:
 * - Contains null bytes (potential injection attack)
 * - Is an absolute path (starting with / or drive letter)
 * - Contains '..' segments that could escape the root
 *
 * Security measures:
 * 1. Rejects paths with null bytes (injection prevention)
 * 2. Rejects absolute paths (starting with / or drive letter)
 * 3. Rejects paths that escape root at any point during traversal
 * 4. Rejects paths that start with '..' after normalization
 */
function isPathSafe(relativePath: string): boolean {
  // Reject paths with null bytes (injection prevention)
  if (relativePath.includes('\0')) {
    return false;
  }

  // Reject absolute paths (Unix-style or Windows-style)
  if (/^[/\\]/.test(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    return false;
  }

  // Normalize path separators and split into segments
  const segments = relativePath.split(/[\\/]/);

  // Track depth - going negative at ANY point means potential escape
  let depth = 0;
  for (const segment of segments) {
    if (segment === '..') {
      depth--;
      // Immediately reject if depth ever goes negative
      if (depth < 0) {
        return false;
      }
    } else if (segment !== '' && segment !== '.') {
      depth++;
    }
  }

  // Additional check: after all processing, verify we haven't escaped
  // This catches edge cases where normalization might differ
  const normalizedSegments = segments.filter((s) => s !== '' && s !== '.');
  if (normalizedSegments[0] === '..') {
    return false;
  }

  return true;
}

/**
 * Safely join a root path with a relative path.
 * Normalizes path separators and removes redundant segments.
 * Works in both browser and Node.js environments.
 *
 * @param rootPath - The root/base path (e.g., folder path)
 * @param relativePath - The relative path to append
 * @returns Normalized joined path, or null if the result escapes the root
 */
function safeJoinPath(rootPath: string, relativePath: string): string | null {
  // Pre-validate the relative path
  if (!isPathSafe(relativePath)) {
    return null;
  }

  // Normalize separators to forward slashes for consistency
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedRelative = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

  // Join with single separator
  const joined = `${normalizedRoot}/${normalizedRelative}`;

  // Normalize: collapse multiple slashes and resolve . segments
  const segments = extractPathSegments(joined).filter((s) => s !== '.');

  // Final validation: ensure no '..' segments remain (should have been caught by isPathSafe)
  if (segments.some((s) => s === '..')) {
    return null;
  }

  // Reconstruct the path
  const result = segments.join('/');

  // Verify the result still starts with the normalized root
  // This catches edge cases where the relative path might escape via encoding tricks
  if (!result.startsWith(normalizedRoot.replace(/\/+$/, ''))) {
    return null;
  }

  return result;
}

/** Status information for a tab's file handle */
export interface TabFileStatus {
  compositeKey: string;
  error?: string | undefined;
  status: TabRestoreStatus;
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
  /** Get display message for tab status */
  getStatusMessage: (compositeKey: string) => string | null;
  /** Whether restoration is currently in progress */
  isRestoring: boolean;
  /** Check if a tab needs user action (permission or removal) */
  needsUserAction: (compositeKey: string) => boolean;
  /** Request permission for a specific tab (must be called from click handler) */
  requestTabPermission: (compositeKey: string) => Promise<boolean>;
  /** Manually trigger restoration for tabs */
  restoreTabs: (tabs: Array<{ tabId: string; compositeKey: string }>) => Promise<void>;
  /** Map of composite key to restoration status */
  tabStatuses: Map<string, TabFileStatus>;
}

/** Shape of file system adapter with exists method (Electron) */
interface AdapterWithExists {
  exists: (path: string) => Promise<boolean>;
}

/**
 * Type guard to check if an adapter has the exists method.
 * Uses proper runtime checks with unknown intermediate type.
 */
function hasExistsMethod(adapter: unknown): adapter is AdapterWithExists {
  if (typeof adapter !== 'object' || adapter === null) {
    return false;
  }
  const candidate = adapter as Record<string, unknown>;
  return typeof candidate['exists'] === 'function';
}

/** Result of Electron tab restoration */
interface ElectronRestoreResult {
  notFound: Array<{ compositeKey: string; error: string }>;
  restored: Array<{ compositeKey: string }>;
}

/**
 * Restore tabs on Electron by checking if files exist directly.
 * No permission handling needed - Electron has full file system access.
 * Uses concurrency limiting to prevent overwhelming the filesystem with many tabs.
 */
async function restoreElectronTabs(
  tabsToRestore: Array<{ tabId: string; compositeKey: string }>,
  adapter: AdapterWithExists,
  onTabNotFound?: (tabId: string) => void
): Promise<ElectronRestoreResult> {
  const restored: Array<{ compositeKey: string }> = [];
  const notFound: Array<{ compositeKey: string; error: string }> = [];

  // Create limiter to prevent overwhelming filesystem with concurrent checks
  const limit = createConcurrencyLimiter(ELECTRON_RESTORE_CONCURRENCY);

  // Process tabs with concurrency limiting
  await Promise.all(
    tabsToRestore.map((tab) =>
      limit(async () => {
        try {
          // Decode the composite key to get folder ID (which is the root path on Electron) and relative path
          const { folderId, path: relativePath } = decodeFileSelection(tab.compositeKey);

          if (!(folderId && relativePath)) {
            notFound.push({ compositeKey: tab.compositeKey, error: 'Invalid composite key' });
            onTabNotFound?.(tab.tabId);
            return;
          }

          // On Electron, folderId is typically the root folder path
          // Construct full path safely with proper validation
          const fullPath = safeJoinPath(folderId, relativePath);

          if (fullPath === null) {
            // Path validation failed (traversal attempt, null bytes, etc.)
            // Log without exposing the raw path in production
            logger.warn('restoreElectronTabs: path validation failed', {
              folderId: folderId.slice(0, 50), // Truncate for safety
              pathLength: relativePath.length,
            });
            notFound.push({
              compositeKey: tab.compositeKey,
              error: 'Invalid path',
            });
            onTabNotFound?.(tab.tabId);
            return;
          }

          // Check if file exists using the adapter
          const exists = await adapter.exists(fullPath);

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
    )
  );

  return { notFound, restored };
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

/** Maximum number of file handles to keep in memory to prevent unbounded growth */
const MAX_CACHED_HANDLES = 100;

/**
 * Store handle in ref map if present, with LRU eviction to prevent memory leaks.
 * When the cache exceeds MAX_CACHED_HANDLES, the oldest entry is removed.
 */
function storeHandleIfPresent(
  handlesRef: React.RefObject<Map<string, FileSystemFileHandle>>,
  compositeKey: string,
  handle: FileSystemFileHandle | null
): void {
  if (!(handle && handlesRef.current)) {
    return;
  }

  // If key already exists, delete it first so it moves to end (most recent)
  if (handlesRef.current.has(compositeKey)) {
    handlesRef.current.delete(compositeKey);
  }

  // Evict oldest entry if at capacity
  if (handlesRef.current.size >= MAX_CACHED_HANDLES) {
    const firstKey = handlesRef.current.keys().next().value;
    if (firstKey !== undefined) {
      handlesRef.current.delete(firstKey);
    }
  }

  handlesRef.current.set(compositeKey, handle);
}

/**
 * Hook to manage file handle restoration for editor tabs.
 *
 * @param tabs - Current tabs from the tab manager store. Tabs with isLoading=true are
 *               actively being opened and should not trigger restoration attempts.
 * @param onTabNotFound - Callback when a tab's file can't be restored (for cleanup)
 */
export function useTabFileRestoration(
  tabs: Array<{ id: string; compositeKey: string; isLoading?: boolean }>,
  onTabNotFound?: (tabId: string) => void
): UseTabFileRestorationReturn {
  const { fileSystemAdapter } = useAdapters();
  const [isRestoring, setIsRestoring] = useState(false);
  const [tabStatuses, setTabStatuses] = useState<Map<string, TabFileStatus>>(new Map());

  // Track which tabs we've already attempted to restore
  const restoredTabsRef = useRef<Set<string>>(new Set());
  // Track handles for permission requests (web platform only)
  const handlesRef = useRef<Map<string, FileSystemFileHandle>>(new Map());
  // Track if a restoration is currently in progress to prevent race conditions
  const restorationInProgressRef = useRef(false);
  // Track the last set of tabs we attempted to restore (for stable key comparison)
  const lastRestoredTabsKeyRef = useRef<string>('');

  // Detect platform once
  const platform = useMemo<Platform>(() => detectPlatform(), []);

  // Get handle cache from adapter (web platform only)
  const handleCache = useMemo(() => {
    if (platform !== 'web') {
      return null;
    }
    return readHandleCache(fileSystemAdapter, isFileHandleCache);
  }, [fileSystemAdapter, platform]);

  // Handle Electron restoration
  const restoreElectronTabsWithStatus = useCallback(
    async (newTabs: Array<{ tabId: string; compositeKey: string }>) => {
      if (!hasExistsMethod(fileSystemAdapter)) {
        logger.warn('Electron adapter missing exists method');
        return;
      }

      const result = await restoreElectronTabs(newTabs, fileSystemAdapter, onTabNotFound);
      setTabStatuses((prev) => updateStatusesFromElectronResult(prev, result));

      logger.info('Tab restoration completed (Electron)', {
        notFound: result.notFound.length,
        restored: result.restored.length,
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
        newTabs.map((t) => ({ compositeKey: t.compositeKey, tabId: t.tabId })),
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
        needsPermission: result.needsPermission.length,
        notFound: result.notFound.length,
        restored: result.restored.length,
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
    // Filter out tabs that are currently loading (newly opened tabs, not persisted ones)
    // Only tabs with isLoading=false need restoration (they came from localStorage hydration)
    const tabsNeedingRestore = tabs.filter(
      (tab) => !(restoredTabsRef.current.has(tab.compositeKey) || tab.isLoading)
    );

    if (tabsNeedingRestore.length === 0) {
      return;
    }

    // Create a stable key from the tabs needing restoration to detect duplicate attempts
    const tabsKey = tabsNeedingRestore
      .map((t) => t.compositeKey)
      .sort()
      .join(',');

    // Skip if we're already restoring the same set of tabs (race condition protection)
    if (restorationInProgressRef.current && lastRestoredTabsKeyRef.current === tabsKey) {
      return;
    }

    // Delay to allow Zustand hydration to complete
    const timer = setTimeout(() => {
      // Double-check we're not already restoring the same tabs
      if (restorationInProgressRef.current && lastRestoredTabsKeyRef.current === tabsKey) {
        return;
      }

      restorationInProgressRef.current = true;
      lastRestoredTabsKeyRef.current = tabsKey;

      void restoreTabsRef
        .current(tabsNeedingRestore.map((t) => ({ compositeKey: t.compositeKey, tabId: t.id })))
        .finally(() => {
          restorationInProgressRef.current = false;
        });
    }, RESTORATION_DELAY_MS);

    return () => clearTimeout(timer);
  }, [platform, handleCache, fileSystemAdapter, tabs]);

  // Memoize tab keys to avoid unnecessary cleanup runs
  const tabKeys = useMemo(() => new Set(tabs.map((t) => t.compositeKey)), [tabs]);

  // Clean up in-memory state when tabs are closed
  // Note: We don't remove file handles from IndexedDB - LRU eviction handles that
  // biome-ignore lint/plugin: This effect cleans up refs, not data fetching
  useEffect(() => {
    // Clean up handles and statuses for closed tabs
    for (const key of handlesRef.current.keys()) {
      if (!tabKeys.has(key)) {
        handlesRef.current.delete(key);
        restoredTabsRef.current.delete(key);
      }
    }

    // Clean up statuses map
    setTabStatuses((prev) => {
      let hasChanges = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!tabKeys.has(key)) {
          next.delete(key);
          hasChanges = true;
        }
      }
      return hasChanges ? next : prev;
    });
  }, [tabKeys]);

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

      // Exhaustive switch for all TabRestoreStatus values
      switch (status.status) {
        case 'needs-permission':
          return 'Click to restore access';
        case 'not-found':
          return status.error ?? 'File no longer available';
        case 'restored':
          return null;
        case 'pending':
          return 'Restoring...';
      }
    },
    [tabStatuses]
  );

  return {
    getStatusMessage,
    isRestoring,
    needsUserAction,
    requestTabPermission,
    restoreTabs,
    tabStatuses,
  };
}
