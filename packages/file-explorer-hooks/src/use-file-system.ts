import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

const logger = createLogger('FileSystemHook');

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
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

export function useFileSystem({ setCurrentFolderId }: UseFileSystemParams) {
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

  // Auto-restore last folder on startup (desktop only). Runs once and never changes hook order.
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
          setCurrentFolderId(restored.name);
        }
      } catch (error) {
        logger.warn('Failed to restore last folder', { error });
      } finally {
        dispatch({ type: 'setAccessLoading', loading: false });
        isRestoringRef.current = false;
      }
    };
    void run();
  }, [fileSystemAdapter, rootDirectoryHandle, setCurrentFolderId]);

  return useMemo(
    () => ({
      rootDirectoryHandle,
      isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
    }),
    [
      rootDirectoryHandle,
      isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
    ]
  );
}
