/**
 * Hook for restoring file handles for persisted editor tabs (BST-307)
 *
 * This hook integrates with the tab manager and file handle cache to restore
 * file handles for tabs that were persisted across browser reloads.
 *
 * Key behaviors:
 * - Automatically attempts restoration when tabs are loaded from storage
 * - Tracks restoration status per-tab for UI display
 * - Cleans up stale tab entries when files no longer exist
 * - Restores on Electron by checking each file path through the adapter
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import { detectPlatform, type Platform } from '@brainstrike/platform-utils';
import { extractPathSegments } from '@brainstrike/utils/path-utils';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  if (/^[/\\]/u.test(relativePath) || /^[a-zA-Z]:/u.test(relativePath)) {
    return false;
  }

  // Normalize path separators and split into segments
  const segments = relativePath.split(/[\\/]/u);

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
  const normalizedRoot = rootPath.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const normalizedRelative = relativePath.replace(/\\/gu, '/').replace(/^\/+/u, '');

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
  if (!result.startsWith(normalizedRoot.replace(/\/+$/u, ''))) {
    return null;
  }

  return result;
}

/** Restoration status of a persisted tab's file. */
export type TabRestoreStatus = 'restored' | 'needs-permission' | 'not-found' | 'pending';

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
  // Track if a restoration is currently in progress to prevent race conditions
  const restorationInProgressRef = useRef(false);
  // Track the last set of tabs we attempted to restore (for stable key comparison)
  const lastRestoredTabsKeyRef = useRef<string>('');

  // Detect platform once
  const platform = useMemo<Platform>(() => detectPlatform(), []);

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

      // Mark as attempted
      for (const tab of newTabs) {
        restoredTabsRef.current.add(tab.compositeKey);
      }

      await restoreElectronTabsWithStatus(newTabs).catch((err: unknown) => {
        logger.warn('Tab restoration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      setIsRestoring(false);
    },
    [restoreElectronTabsWithStatus]
  );

  // Store restoreTabs in a ref to avoid useEffect re-running when callback changes
  const restoreTabsRef = useRef(restoreTabs);
  useLayoutEffect(() => {
    restoreTabsRef.current = restoreTabs;
  });

  // Auto-restore tabs on mount/when tabs change
  useEffect(() => {
    // Only Electron restores persisted tabs, through its adapter.
    if (platform !== 'electron' || !fileSystemAdapter) {
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
  }, [platform, fileSystemAdapter, tabs]);

  // Memoize tab keys to avoid unnecessary cleanup runs
  const tabKeys = useMemo(() => new Set(tabs.map((t) => t.compositeKey)), [tabs]);

  // Clean up statuses when tabs are closed
  // biome-ignore lint/plugin: This effect cleans up refs, not data fetching
  useEffect(() => {
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

  // Electron has direct file access, so no tab waits on a permission prompt.
  const requestTabPermission = useCallback(
    (_compositeKey: string): Promise<boolean> => Promise.resolve(platform === 'electron'),
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
