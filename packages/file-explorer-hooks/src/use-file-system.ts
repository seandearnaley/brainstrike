import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useEffect, useState } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
}

export function useFileSystem({ setCurrentFolderId }: UseFileSystemParams) {
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const [hasAttemptedRestore, setHasAttemptedRestore] = useState(false);
  const { fileSystemAdapter } = useAdapters();

  // Track if we're currently in the process of restoring to prevent concurrent attempts
  const [isRestoring, setIsRestoring] = useState(false);

  // Auto-restore last folder on desktop startup
  // biome-ignore lint/correctness/useExhaustiveDependencies: We only want this to run once on mount
  useEffect(() => {
    // Only run once on mount when no folder is selected
    if (hasAttemptedRestore || rootDirectoryHandle || isRestoring) {
      return;
    }

    // Only attempt restore if the adapter supports it (desktop only)
    if (!fileSystemAdapter.restoreLastFolder) {
      setHasAttemptedRestore(true);
      return;
    }

    const attemptAutoRestore = async () => {
      setIsRestoring(true);
      setHasAttemptedRestore(true);

      try {
        setIsAccessLoading(true);
        const restoredHandle = await fileSystemAdapter.restoreLastFolder?.();

        if (restoredHandle) {
          // Batch state updates together to minimize re-renders
          setRootDirectoryHandle(restoredHandle);
          // Only update folder ID if setCurrentFolderId is provided
          if (setCurrentFolderId) {
            setCurrentFolderId(restoredHandle.name);
          }
        }
      } catch (_error) {
        // Silently fail - user can manually select folder
      } finally {
        setIsAccessLoading(false);
        setIsRestoring(false);
      }
    };

    void attemptAutoRestore();
  }, []);

  const isFileSystemAccessSupported = (): {
    supported: boolean;
    reason: string;
  } => {
    const hasWebAPI =
      typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
    const hasAdapterAPI = typeof fileSystemAdapter?.requestDirectoryAccess === 'function';
    if (hasWebAPI || hasAdapterAPI) return { supported: true, reason: '' };
    return {
      supported: false,
      reason: 'File system access not supported in this environment',
    };
  };

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      throw new Error(reason);
    }

    setIsAccessLoading(true);
    try {
      const handle = await fileSystemAdapter.requestDirectoryAccess();
      setRootDirectoryHandle(handle);
      setCurrentFolderId(handle.name);
      return handle;
    } catch (error) {
      if (isUserCancellation(error)) {
        return null;
      }

      throw mapFileSystemError(error);
    } finally {
      setIsAccessLoading(false);
    }
  };

  return {
    rootDirectoryHandle,
    isAccessLoading,
    selectRootDirectory,
    isFileSystemAccessSupported,
  };
}
