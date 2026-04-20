import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

const logger = createLogger('FileSystemHook');

interface UseFileSystemParams {
  /**
   * Optional getter for the store's persisted currentFolderId.
   * Used during auto-restore to avoid redundant setCurrentFolderId calls
   * when the folder ID matches what will be hydrated from persistence.
   */
  getPersistedCurrentFolderId?: () => string | null;
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
  /**
   * Optional callback to check if store has finished hydrating from persistence.
   * When provided, the auto-restore effect will wait for hydration before calling
   * setCurrentFolderId, preventing race conditions where empty initial state
   * overwrites persisted selections.
   */
  waitForHydration?: () => Promise<void>;
}

interface FileSystemState {
  isAccessLoading: boolean;
  rootDirectoryHandle: DirectoryHandle | null;
}

type FileSystemAction =
  | { type: 'setRoot'; handle: DirectoryHandle | null }
  | { type: 'setAccessLoading'; loading: boolean };

function getCanonicalFolderId(handle: DirectoryHandle): string {
  if (!handle.path) {
    throw new Error('Directory handle is missing its canonical path');
  }
  return handle.path;
}

function reducer(state: FileSystemState, action: FileSystemAction): FileSystemState {
  switch (action.type) {
    case 'setRoot':
      return { ...state, rootDirectoryHandle: action.handle };
    case 'setAccessLoading':
      return { ...state, isAccessLoading: action.loading };
    default:
      return state;
  }
}

export function useFileSystem({
  setCurrentFolderId,
  waitForHydration,
  getPersistedCurrentFolderId,
}: UseFileSystemParams) {
  const { fileSystemAdapter } = useAdapters();

  const [{ rootDirectoryHandle, isAccessLoading }, dispatch] = useReducer(reducer, {
    rootDirectoryHandle: null,
    isAccessLoading: false,
  });

  const hasAttemptedRestoreRef = useRef(false);
  const isRestoringRef = useRef(false);
  const updateCurrentFolderId = useCallback(
    (folderId: string | null) => {
      if (typeof setCurrentFolderId === 'function') {
        setCurrentFolderId(folderId);
      } else {
        logger.warn('setCurrentFolderId is unavailable; skipping folder id update', {
          folderId,
        });
      }
    },
    [setCurrentFolderId]
  );

  const isFileSystemAccessSupported = useCallback((): { supported: boolean; reason: string } => {
    const hasWebAPI =
      typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    const hasAdapterAPI = typeof fileSystemAdapter?.requestDirectoryAccess === 'function';
    if (hasWebAPI || hasAdapterAPI) {
      return { supported: true, reason: '' };
    }
    return { supported: false, reason: 'File system access not supported in this environment' };
  }, [fileSystemAdapter]);

  const selectRootDirectory = useCallback(async (): Promise<DirectoryHandle | null> => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      throw new Error(reason);
    }
    dispatch({ type: 'setAccessLoading', loading: true });
    try {
      const handle = await fileSystemAdapter.requestDirectoryAccess();
      dispatch({ type: 'setRoot', handle });
      updateCurrentFolderId(getCanonicalFolderId(handle));
      return handle;
    } catch (error) {
      if (isUserCancellation(error)) {
        return null;
      }
      throw mapFileSystemError(error);
    } finally {
      dispatch({ type: 'setAccessLoading', loading: false });
    }
  }, [fileSystemAdapter, isFileSystemAccessSupported, updateCurrentFolderId]);

  const clearRootDirectory = useCallback(() => {
    dispatch({ type: 'setRoot', handle: null });
    updateCurrentFolderId(null);
  }, [updateCurrentFolderId]);

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * This allows the useRestoreAccess hook to update the root handle after
   * successful permission restoration.
   */
  const setRootDirectoryHandle = useCallback(
    (handle: DirectoryHandle | null) => {
      dispatch({ type: 'setRoot', handle });
      if (handle) {
        updateCurrentFolderId(getCanonicalFolderId(handle));
      } else {
        updateCurrentFolderId(null);
      }
    },
    [updateCurrentFolderId]
  );

  /**
   * Set the access loading state.
   * Used by restore flow to signal that a restore is in progress, which
   * prevents the stale state clearing effect from clearing expanded paths
   * while waiting for browser permission dialog.
   */
  const setAccessLoading = useCallback((loading: boolean) => {
    dispatch({ type: 'setAccessLoading', loading });
  }, []);

  const applyRestoredFolderState = useCallback(
    async (restored: DirectoryHandle, isCancelled: () => boolean) => {
      if (isCancelled()) {
        return;
      }
      // CRITICAL: Wait for store hydration before calling setCurrentFolderId.
      // Without this, the store may still have empty initial state, and
      // setCurrentFolderId would read from the empty folderStates, overwriting
      // the persisted selections that are about to be hydrated.
      if (waitForHydration) {
        await waitForHydration();
      }
      if (isCancelled()) {
        return;
      }
      dispatch({ type: 'setRoot', handle: restored });
      const restoredFolderId = getCanonicalFolderId(restored);

      // Check if the persisted currentFolderId already matches.
      // If so, skip calling setCurrentFolderId to avoid triggering the
      // folder-switching logic which would read from stale folderStates.
      const persistedFolderId = getPersistedCurrentFolderId?.();
      if (persistedFolderId === restoredFolderId) {
        logger.debug('Skipping setCurrentFolderId - folder already matches persisted state', {
          folderId: restoredFolderId,
        });
      } else {
        updateCurrentFolderId(restoredFolderId);
      }
    },
    [getPersistedCurrentFolderId, updateCurrentFolderId, waitForHydration]
  );

  // Auto-restore last folder on startup. Runs once and never changes hook order.
  useEffect(() => {
    if (hasAttemptedRestoreRef.current || rootDirectoryHandle || isRestoringRef.current) {
      return;
    }
    if (typeof fileSystemAdapter.restoreLastFolder !== 'function') {
      return;
    }
    // CRITICAL: Set loading state SYNCHRONOUSLY before starting async operation.
    // This prevents race conditions where other effects (like stale state clearing)
    // might see isAccessLoading=false and rootDirectoryHandle=null before the
    // restore completes, causing them to incorrectly clear persisted state.
    isRestoringRef.current = true;
    dispatch({ type: 'setAccessLoading', loading: true });

    let cancelled = false;

    const run = async () => {
      try {
        const restoreFn = (
          fileSystemAdapter as { restoreLastFolder?: () => Promise<DirectoryHandle | null> }
        ).restoreLastFolder;
        if (!restoreFn) {
          return;
        }
        const restored = await restoreFn();
        if (!restored || cancelled) {
          return;
        }
        await applyRestoredFolderState(restored, () => cancelled);
      } catch (error) {
        if (!cancelled) {
          logger.warn('Failed to restore last folder', { error });
        }
      } finally {
        if (!cancelled) {
          // Mark as attempted only after a non-cancelled completion.
          // This allows retries when a run is cancelled (e.g. effect preflight cleanup).
          hasAttemptedRestoreRef.current = true;
          dispatch({ type: 'setAccessLoading', loading: false });
        }
        isRestoringRef.current = false;
      }
    };
    void run();
    return () => {
      cancelled = true;
      isRestoringRef.current = false;
    };
  }, [
    fileSystemAdapter,
    rootDirectoryHandle,
    updateCurrentFolderId,
    applyRestoredFolderState,
    waitForHydration,
    getPersistedCurrentFolderId,
  ]);

  return useMemo(
    () => ({
      rootDirectoryHandle,
      isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle,
      setAccessLoading,
    }),
    [
      rootDirectoryHandle,
      isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle,
      setAccessLoading,
    ]
  );
}
