import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

const logger = createLogger('FileSystemHook');

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
  /**
   * Optional callback to check if store has finished hydrating from persistence.
   * When provided, the auto-restore effect will wait for hydration before calling
   * setCurrentFolderId, preventing race conditions where empty initial state
   * overwrites persisted selections.
   */
  waitForHydration?: () => Promise<void>;
  /**
   * Optional getter for the store's persisted currentFolderId.
   * Used during auto-restore to avoid redundant setCurrentFolderId calls
   * when the folder ID matches what will be hydrated from persistence.
   */
  getPersistedCurrentFolderId?: () => string | null;
}

interface FileSystemState {
  rootDirectoryHandle: DirectoryHandle | null;
  isAccessLoading: boolean;
}

type FileSystemAction =
  | { type: 'setRoot'; handle: DirectoryHandle | null }
  | { type: 'setAccessLoading'; loading: boolean };

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
      setCurrentFolderId(handle.name);
      return handle;
    } catch (error) {
      if (isUserCancellation(error)) {
        return null;
      }
      throw mapFileSystemError(error);
    } finally {
      dispatch({ type: 'setAccessLoading', loading: false });
    }
  }, [fileSystemAdapter, isFileSystemAccessSupported, setCurrentFolderId]);

  const clearRootDirectory = useCallback(() => {
    dispatch({ type: 'setRoot', handle: null });
    setCurrentFolderId(null);
  }, [setCurrentFolderId]);

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * This allows the useRestoreAccess hook to update the root handle after
   * successful permission restoration.
   */
  const setRootDirectoryHandle = useCallback(
    (handle: DirectoryHandle | null) => {
      dispatch({ type: 'setRoot', handle });
      if (handle) {
        setCurrentFolderId(handle.name);
      } else {
        setCurrentFolderId(null);
      }
    },
    [setCurrentFolderId]
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

  // Auto-restore last folder on startup. Runs once and never changes hook order.
  useEffect(() => {
    if (hasAttemptedRestoreRef.current || rootDirectoryHandle || isRestoringRef.current) {
      return;
    }
    hasAttemptedRestoreRef.current = true;
    if (typeof fileSystemAdapter.restoreLastFolder !== 'function') {
      return;
    }
    // CRITICAL: Set loading state SYNCHRONOUSLY before starting async operation.
    // This prevents race conditions where other effects (like stale state clearing)
    // might see isAccessLoading=false and rootDirectoryHandle=null before the
    // restore completes, causing them to incorrectly clear persisted state.
    isRestoringRef.current = true;
    dispatch({ type: 'setAccessLoading', loading: true });

    const run = async () => {
      try {
        const restoreFn = (
          fileSystemAdapter as { restoreLastFolder?: () => Promise<DirectoryHandle | null> }
        ).restoreLastFolder;
        if (!restoreFn) {
          return;
        }
        const restored = await restoreFn();
        if (restored) {
          dispatch({ type: 'setRoot', handle: restored });

          // CRITICAL: Wait for store hydration before calling setCurrentFolderId.
          // Without this, the store may still have empty initial state, and
          // setCurrentFolderId would read from the empty folderStates, overwriting
          // the persisted selections that are about to be hydrated.
          if (waitForHydration) {
            await waitForHydration();
          }

          // Check if the persisted currentFolderId already matches.
          // If so, skip calling setCurrentFolderId to avoid triggering the
          // folder-switching logic which would read from stale folderStates.
          const persistedFolderId = getPersistedCurrentFolderId?.();
          if (persistedFolderId !== restored.name) {
            setCurrentFolderId(restored.name);
          } else {
            logger.debug('Skipping setCurrentFolderId - folder already matches persisted state', {
              folderId: restored.name,
            });
          }
        }
      } catch (error) {
        logger.warn('Failed to restore last folder', { error });
      } finally {
        dispatch({ type: 'setAccessLoading', loading: false });
        isRestoringRef.current = false;
      }
    };
    void run();
  }, [
    fileSystemAdapter,
    rootDirectoryHandle,
    setCurrentFolderId,
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
