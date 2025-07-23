/**
 * File System Hook (Context-aware)
 *
 * This hook provides file system functionality using the context-based store.
 */

import { useFileSystem as useCoreFileSystem } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useEffect, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

// Error message mappings for consistent user experience
const ERROR_MESSAGES = {
  permissionDenied:
    'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.',
  dialogFailed: 'Could not open the folder selection dialog. Please try again.',
  directoryReadFailed:
    'Cannot read the selected directory. Please ensure you have proper access permissions.',
  directoryAccessFailed:
    'Cannot access the selected directory. Please ensure you have proper access permissions.',
  genericError: 'An unexpected error occurred while selecting the directory.',
} as const;

// Error mapping configuration
const ERROR_PATTERNS = [
  { pattern: /Permission denied/i, message: ERROR_MESSAGES.permissionDenied },
  {
    pattern: /Unable to open directory selection dialog|Failed to open directory dialog/i,
    message: ERROR_MESSAGES.dialogFailed,
  },
  {
    pattern: /Unable to read the selected directory/i,
    message: ERROR_MESSAGES.directoryReadFailed,
  },
  {
    pattern: /Cannot access selected directory/i,
    message: ERROR_MESSAGES.directoryAccessFailed,
  },
] as const;

// Helper function to map error messages to user-friendly text
function getUserFriendlyErrorMessage(errorMessage: string): string {
  const matchedPattern = ERROR_PATTERNS.find(({ pattern }) => pattern.test(errorMessage));
  return matchedPattern ? matchedPattern.message : errorMessage;
}

// Helper function to handle directory selection with proper error handling
async function selectDirectoryWithErrorHandling(
  coreApi: ReturnType<typeof useCoreFileSystem>,
  setRootDirectoryHandle: (handle: DirectoryHandle | null) => void,
  setIsAccessLoading: (loading: boolean) => void
): Promise<DirectoryHandle | null> {
  const { supported, reason } = coreApi.isFileSystemAccessSupported();
  if (!supported) {
    throw new Error(reason);
  }

  setIsAccessLoading(true);
  try {
    const handle = await coreApi.selectRootDirectory();
    if (handle) {
      setRootDirectoryHandle(handle);
    }
    return handle;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? getUserFriendlyErrorMessage(error.message)
        : ERROR_MESSAGES.genericError;
    throw new Error(errorMessage);
  } finally {
    setIsAccessLoading(false);
  }
}

export function useFileSystem() {
  console.log('[Context useFileSystem] Hook initialized');
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const store = useFileExplorerStoreContext();
  const { setCurrentFolderId } = store((s) => ({ setCurrentFolderId: s.setCurrentFolderId }));

  const coreApi = useCoreFileSystem({ setCurrentFolderId });
  console.log('[Context useFileSystem] Core API:', { hasRootHandle: !!coreApi.rootDirectoryHandle, isLoading: coreApi.isAccessLoading });

  // Sync with core hook's auto-restored state
  useEffect(() => {
    console.log('[Context Hook] Core hook state changed:', { coreHandle: !!coreApi.rootDirectoryHandle, localHandle: !!rootDirectoryHandle });
    if (coreApi.rootDirectoryHandle && !rootDirectoryHandle) {
      console.log('[Context Hook] Syncing auto-restored directory from core hook:', coreApi.rootDirectoryHandle);
      setRootDirectoryHandle(coreApi.rootDirectoryHandle);
    }
  }, [coreApi.rootDirectoryHandle, rootDirectoryHandle]);

  // Also sync loading state
  useEffect(() => {
    if (coreApi.isAccessLoading !== isAccessLoading) {
      console.log('[Context Hook] Syncing loading state:', coreApi.isAccessLoading);
      setIsAccessLoading(coreApi.isAccessLoading);
    }
  }, [coreApi.isAccessLoading, isAccessLoading]);

  const isFileSystemAccessSupported = (): {
    supported: boolean;
    reason: string;
  } => {
    return coreApi.isFileSystemAccessSupported();
  };

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
    return selectDirectoryWithErrorHandling(coreApi, setRootDirectoryHandle, setIsAccessLoading);
  };

  return {
    rootDirectoryHandle,
    isAccessLoading,
    selectRootDirectory,
    isFileSystemAccessSupported,
  };
}
