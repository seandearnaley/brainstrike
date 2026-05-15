import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAdapters } from './adapters-context';

const logger = createLogger('useRestoreAccess');

/**
 * Delay before checking stored handles on mount.
 * This prevents UI flash if IndexedDB check completes quickly,
 * while still allowing the restore modal to appear promptly.
 */
const HANDLE_CHECK_DELAY_MS = 500;

type RestoreAccessClearListener = () => void;

const clearListeners = new Set<RestoreAccessClearListener>();

function subscribeToStoredHandlesCleared(listener: RestoreAccessClearListener): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
}

function broadcastStoredHandlesCleared(): void {
  for (const listener of clearListeners) {
    listener();
  }
}

export interface PendingRestoreState {
  folderId: string;
  name: string;
  /** Current permission state */
  permissionState: PermissionState | 'unknown';
  /** The raw FileSystemDirectoryHandle for requesting permission synchronously */
  rawHandle: FileSystemDirectoryHandle;
}

interface RestoreAccessState {
  /**
   * Begin restore - requests permission SYNCHRONOUSLY in the click handler.
   * MUST be called directly from a user gesture (click) handler.
   */
  beginRestore: () => Promise<DirectoryHandle | null>;
  chooseDifferentFolder: () => Promise<DirectoryHandle | null>;
  clearStoredHandles: () => Promise<void>;
  dismissRestore: () => void;
  /** Whether the hook is still checking for stored handles on startup */
  isCheckingStoredHandles: boolean;
  pendingRestore: PendingRestoreState | null;
  showDeniedBanner: boolean;
  showStaleBanner: boolean;
  storedFolders: Array<{ folderId: string; name: string }>;
}

interface RestoreHandleResult {
  folderId: string;
  handle: FileSystemDirectoryHandle;
  name: string;
  permissionState: PermissionState | 'unknown';
}

interface WebHandleCacheShape {
  clear?: () => Promise<void>;
  getAllRootHandles?: () => Promise<
    Array<{ folderId: string; name: string; lastAccessedAt: number }>
  >;
  getLastRootHandleForRestore?: () => Promise<RestoreHandleResult | null>;
  markHandleRestored?: (folderId: string) => Promise<void>;
  removeRootHandle?: (folderId: string) => Promise<void>;
  restoreLastRootHandle?: () => Promise<{ handle: FileSystemDirectoryHandle } | null>;
}

interface WebAdapterWithCache {
  getHandleCache?: () => WebHandleCacheShape;
}

interface LoadStoredHandlesOptions {
  dismissedRef: { current: boolean };
  handleCache: WebHandleCacheShape | null;
  hasNewMethod: boolean;
  hasOldMethod: boolean;
  setPendingRestore: (state: PendingRestoreState | null) => void;
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void;
}

/** Convert a raw FileSystemDirectoryHandle to our DirectoryHandle type */
function toDirectoryHandle(rawHandle: FileSystemDirectoryHandle): DirectoryHandle {
  return {
    path: rawHandle.name,
    name: rawHandle.name,
    kind: 'directory',
    platform: 'web',
    _internal: rawHandle,
  };
}

/** Load handles using the new getLastRootHandleForRestore method */
async function loadHandlesNewMethod(
  handleCache: WebHandleCacheShape,
  setPendingRestore: (state: PendingRestoreState | null) => void,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void
): Promise<void> {
  const result = await handleCache.getLastRootHandleForRestore?.();
  logger.info('getLastRootHandleForRestore result', {
    hasResult: !!result,
    permissionState: result?.permissionState,
  });

  if (result) {
    setPendingRestore({
      folderId: result.folderId,
      name: result.name,
      rawHandle: result.handle,
      permissionState: result.permissionState,
    });

    const allHandles = await handleCache.getAllRootHandles?.();
    if (allHandles) {
      setStoredFolders(allHandles.map((h) => ({ folderId: h.folderId, name: h.name })));
    }
  } else {
    setStoredFolders([]);
  }
}

/** Load handles using the legacy getAllRootHandles method */
async function loadHandlesLegacyMethod(
  handleCache: WebHandleCacheShape,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void
): Promise<void> {
  const handles = await handleCache.getAllRootHandles?.();
  logger.info('Loaded stored root handles (legacy)', { count: handles?.length ?? 0 });
  if (!handles || handles.length === 0) {
    setStoredFolders([]);
    return;
  }
  setStoredFolders(handles.map((h) => ({ folderId: h.folderId, name: h.name })));
}

async function loadStoredHandles({
  dismissedRef,
  handleCache,
  hasNewMethod,
  hasOldMethod,
  setPendingRestore,
  setStoredFolders,
}: LoadStoredHandlesOptions): Promise<void> {
  if (dismissedRef.current || !handleCache) {
    return;
  }
  if (hasNewMethod) {
    await loadHandlesNewMethod(handleCache, setPendingRestore, setStoredFolders);
    return;
  }
  if (hasOldMethod) {
    await loadHandlesLegacyMethod(handleCache, setStoredFolders);
  }
}

/**
 * Validate and get the authoritative folderId from the handle.
 * If folderId doesn't match the handle name, logs a warning, cleans up the stale
 * cache entry, and returns the handle name as the authoritative source.
 */
function getValidatedFolderIdAndCleanup(
  rawHandle: FileSystemDirectoryHandle,
  storedFolderId: string,
  handleCache: WebHandleCacheShape | null
): string {
  const validatedFolderId = rawHandle.name;

  if (storedFolderId !== validatedFolderId) {
    logger.warn('folderId mismatch with handle name', {
      storedFolderId,
      handleName: validatedFolderId,
    });
    // Clean up the stale cache entry asynchronously (doesn't block restore)
    handleCache?.removeRootHandle?.(storedFolderId).catch((err) => {
      logger.warn('Failed to remove stale cache entry', {
        folderId: storedFolderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return validatedFolderId;
}

/** Request permission and return DirectoryHandle if granted */
async function requestPermissionAndRestore(
  rawHandle: FileSystemDirectoryHandle,
  folderId: string,
  handleCache: WebHandleCacheShape | null,
  setPendingRestore: (state: PendingRestoreState | null) => void
): Promise<{ handle: DirectoryHandle | null; showDenied: boolean; showStale: boolean }> {
  if (typeof rawHandle.requestPermission !== 'function') {
    logger.warn('beginRestore: handle lacks requestPermission method');
    return { handle: null, showDenied: false, showStale: true };
  }

  try {
    // CRITICAL: This requestPermission call happens synchronously in the click handler chain
    const permissionResult = await rawHandle.requestPermission({ mode: 'read' });
    logger.info('beginRestore: permission result', { permissionResult });

    if (permissionResult === 'granted') {
      await handleCache?.markHandleRestored?.(folderId);
      setPendingRestore(null);
      return { handle: toDirectoryHandle(rawHandle), showDenied: false, showStale: false };
    }

    if (permissionResult === 'denied') {
      return { handle: null, showDenied: true, showStale: false };
    }

    return { handle: null, showDenied: false, showStale: true };
  } catch (error) {
    // Differentiate error types for better UX
    const errorName = error instanceof Error ? error.name : '';
    const errorMessage = error instanceof Error ? error.message : String(error);

    // AbortError: User cancelled the permission dialog - not a real error
    if (errorName === 'AbortError') {
      logger.debug('beginRestore: user cancelled permission dialog');
      return { handle: null, showDenied: false, showStale: false };
    }

    // NotFoundError: Handle points to deleted/moved directory - treat as stale
    if (errorName === 'NotFoundError') {
      logger.info('beginRestore: handle target no longer exists', { error: errorMessage });
      await handleCache?.removeRootHandle?.(folderId);
      setPendingRestore(null);
      return { handle: null, showDenied: false, showStale: true };
    }

    // Other errors - log and show stale banner
    logger.warn('beginRestore: permission request failed', {
      errorName,
      error: errorMessage,
    });
    return { handle: null, showDenied: false, showStale: true };
  }
}

/** Legacy restore using restoreLastRootHandle */
async function legacyRestore(
  handleCache: WebHandleCacheShape,
  setPendingRestore: (state: PendingRestoreState | null) => void,
  setStoredFolders: (folders: Array<{ folderId: string; name: string }>) => void
): Promise<{ handle: DirectoryHandle | null; showDenied: boolean; showStale: boolean }> {
  try {
    logger.debug('beginRestore: using legacy restoreLastRootHandle');
    const result = await handleCache.restoreLastRootHandle?.();

    if (!result?.handle) {
      const remaining = await handleCache.getAllRootHandles?.();
      const hasRemaining = Boolean(remaining && remaining.length > 0);
      return { handle: null, showDenied: hasRemaining, showStale: !hasRemaining };
    }

    setPendingRestore(null);
    const remaining = await handleCache.getAllRootHandles?.();
    if (remaining) {
      setStoredFolders(remaining.map((h) => ({ folderId: h.folderId, name: h.name })));
    }

    logger.info('beginRestore: successfully restored handle', { name: result.handle.name });
    return { handle: toDirectoryHandle(result.handle), showDenied: false, showStale: false };
  } catch (error) {
    logger.warn('Failed to restore handle', { error });
    return { handle: null, showDenied: false, showStale: true };
  }
}

export function useRestoreAccess(): RestoreAccessState {
  const { fileSystemAdapter } = useAdapters();
  const [pendingRestore, setPendingRestore] = useState<PendingRestoreState | null>(null);
  const [showDeniedBanner, setShowDeniedBanner] = useState(false);
  const [showStaleBanner, setShowStaleBanner] = useState(false);
  const [storedFolders, setStoredFolders] = useState<Array<{ folderId: string; name: string }>>([]);
  const [isCheckingStoredHandles, setIsCheckingStoredHandles] = useState(true);
  const dismissedRef = useRef(false);
  const isMountedRef = useRef(true);

  // Track mounted state to prevent stale state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleCache = useMemo(() => {
    const adapter = fileSystemAdapter as WebAdapterWithCache | null;
    const cache = adapter?.getHandleCache?.() ?? null;
    if (cache) {
      logger.debug('Handle cache available for restore checks', {
        hasNewMethod: typeof cache.getLastRootHandleForRestore === 'function',
      });
    }
    return cache;
  }, [fileSystemAdapter]);

  const clearLocalRestoreState = useCallback((): void => {
    dismissedRef.current = true;
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
    setStoredFolders([]);
    setIsCheckingStoredHandles(false);
  }, []);

  useEffect(
    () => subscribeToStoredHandlesCleared(clearLocalRestoreState),
    [clearLocalRestoreState]
  );

  // Load stored handles on startup
  useEffect(() => {
    if (dismissedRef.current) {
      logger.debug('Skipping restore check - already dismissed');
      setIsCheckingStoredHandles(false);
      return;
    }

    const hasNewMethod = typeof handleCache?.getLastRootHandleForRestore === 'function';
    const hasOldMethod = typeof handleCache?.getAllRootHandles === 'function';

    if (!(hasNewMethod || hasOldMethod)) {
      setIsCheckingStoredHandles(false);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          await loadStoredHandles({
            dismissedRef,
            handleCache,
            hasNewMethod,
            hasOldMethod,
            setPendingRestore,
            setStoredFolders,
          });
        } catch (error) {
          logger.warn('Failed to load stored root handles', { error });
        } finally {
          // Only update state if still mounted
          if (isMountedRef.current) {
            setIsCheckingStoredHandles(false);
          }
        }
      })();
    }, HANDLE_CHECK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [handleCache]);

  const beginRestore = useCallback(async (): Promise<DirectoryHandle | null> => {
    logger.info('beginRestore called', {
      hasPendingRestore: !!pendingRestore,
      hasRawHandle: !!pendingRestore?.rawHandle,
      permissionState: pendingRestore?.permissionState,
    });

    setShowDeniedBanner(false);
    setShowStaleBanner(false);

    // NEW PATH: We have the raw handle - request permission synchronously
    if (pendingRestore?.rawHandle) {
      const { rawHandle, folderId, permissionState } = pendingRestore;

      // Use validated folderId to prevent state corruption from stale cache entries
      // Also cleans up any stale cache entries if folderId doesn't match handle name
      const validatedFolderId = getValidatedFolderIdAndCleanup(rawHandle, folderId, handleCache);

      // If already granted, just return it
      if (permissionState === 'granted') {
        logger.info('beginRestore: permission already granted');
        await handleCache?.markHandleRestored?.(validatedFolderId);
        setPendingRestore(null);
        return toDirectoryHandle(rawHandle);
      }

      // If denied, show banner
      if (permissionState === 'denied') {
        logger.info('beginRestore: permission denied');
        setShowDeniedBanner(true);
        return null;
      }

      // Permission is 'prompt' or 'unknown' - request it NOW
      logger.info('beginRestore: requesting permission synchronously');
      const result = await requestPermissionAndRestore(
        rawHandle,
        validatedFolderId,
        handleCache,
        setPendingRestore
      );

      if (result.showDenied) {
        setShowDeniedBanner(true);
      }
      if (result.showStale) {
        setShowStaleBanner(true);
      }
      return result.handle;
    }

    // LEGACY PATH: No raw handle, use old restoreLastRootHandle method
    if (!handleCache?.restoreLastRootHandle) {
      logger.warn('beginRestore: no restore method available');
      return null;
    }

    const result = await legacyRestore(handleCache, setPendingRestore, setStoredFolders);
    if (result.showDenied) {
      setShowDeniedBanner(true);
    }
    if (result.showStale) {
      setShowStaleBanner(true);
    }
    return result.handle;
  }, [handleCache, pendingRestore]);

  const dismissRestore = useCallback(() => {
    dismissedRef.current = true;
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
  }, []);

  const chooseDifferentFolder = useCallback(async (): Promise<DirectoryHandle | null> => {
    setPendingRestore(null);
    setShowDeniedBanner(false);
    setShowStaleBanner(false);
    dismissedRef.current = true;
    if (typeof fileSystemAdapter.requestDirectoryAccess === 'function') {
      return fileSystemAdapter.requestDirectoryAccess();
    }
    return null;
  }, [fileSystemAdapter]);

  const clearStoredHandles = useCallback(async (): Promise<void> => {
    if (handleCache?.clear) {
      await handleCache.clear();
    }
    broadcastStoredHandlesCleared();
  }, [handleCache]);

  return {
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
    storedFolders,
    beginRestore,
    dismissRestore,
    chooseDifferentFolder,
    clearStoredHandles,
  };
}
