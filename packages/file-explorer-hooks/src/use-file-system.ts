import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useEffect, useState } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
}

export function useFileSystem({ setCurrentFolderId }: UseFileSystemParams) {
  console.log('[useFileSystem] Hook initialized');
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const [hasAttemptedRestore, setHasAttemptedRestore] = useState(false);
  const { fileSystemAdapter } = useAdapters();
  
  console.log('[useFileSystem] Current state:', { rootDirectoryHandle: !!rootDirectoryHandle, isAccessLoading, hasAttemptedRestore, adapterSupportsRestore: !!fileSystemAdapter.restoreLastFolder });

  // Track if we're currently in the process of restoring to prevent concurrent attempts
  const [isRestoring, setIsRestoring] = useState(false);

  // Auto-restore last folder on desktop startup
  // biome-ignore lint/correctness/useExhaustiveDependencies: We only want this to run once on mount
  useEffect(() => {
    console.log('[Auto-restore] Effect triggered', { hasAttemptedRestore, rootDirectoryHandle, isRestoring });
    
    // Only run once on mount when no folder is selected
    if (hasAttemptedRestore || rootDirectoryHandle || isRestoring) {
      console.log('[Auto-restore] Skipping - already attempted or folder selected');
      return;
    }

    // Only attempt restore if the adapter supports it (desktop only)
    if (!fileSystemAdapter.restoreLastFolder) {
      console.log('[Auto-restore] Adapter does not support restoreLastFolder (web app)');
      setHasAttemptedRestore(true);
      return;
    }

    console.log('[Auto-restore] Starting auto-restore attempt');

    const attemptAutoRestore = async () => {
      setIsRestoring(true);
      setHasAttemptedRestore(true);

      try {
        setIsAccessLoading(true);
        console.log('[Auto-restore] Calling restoreLastFolder...');
        const restoredHandle = await fileSystemAdapter.restoreLastFolder!();
        console.log('[Auto-restore] Restored handle:', restoredHandle);

        if (restoredHandle) {
          console.log('[Auto-restore] Setting restored folder:', restoredHandle.name, restoredHandle.path);
          // Batch state updates together to minimize re-renders
          setRootDirectoryHandle(restoredHandle);
          // Only update folder ID if setCurrentFolderId is provided
          if (setCurrentFolderId) {
            setCurrentFolderId(restoredHandle.name);
          }
        } else {
          console.log('[Auto-restore] No folder to restore');
        }
      } catch (error) {
        console.error('[Auto-restore] Failed:', error);
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
    try {
      // Try to create an adapter to check if the platform is supported
      // This will throw if the platform doesn't support file system access
      return { supported: true, reason: '' };
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : 'File system access not supported',
      };
    }
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
