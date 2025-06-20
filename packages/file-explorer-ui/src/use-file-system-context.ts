/**
 * File System Hook (Context-aware)
 *
 * This hook provides file system functionality using the context-based store.
 */

import { useFileSystem as useCoreFileSystem } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useState } from 'react';
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

// Helper function to map error messages to user-friendly text
function getUserFriendlyErrorMessage(errorMessage: string): string {
  if (errorMessage.includes('Permission denied')) {
    return ERROR_MESSAGES.permissionDenied;
  }

  if (
    errorMessage.includes('Unable to open directory selection dialog') ||
    errorMessage.includes('Failed to open directory dialog')
  ) {
    return ERROR_MESSAGES.dialogFailed;
  }

  if (errorMessage.includes('Unable to read the selected directory')) {
    return ERROR_MESSAGES.directoryReadFailed;
  }

  if (errorMessage.includes('Cannot access selected directory')) {
    return ERROR_MESSAGES.directoryAccessFailed;
  }

  // For any other errors, pass through the message as-is since it's already user-friendly
  return errorMessage;
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
    if (error instanceof Error) {
      throw new Error(getUserFriendlyErrorMessage(error.message));
    }
    throw new Error(ERROR_MESSAGES.genericError);
  } finally {
    setIsAccessLoading(false);
  }
}

export function useFileSystem() {
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const store = useFileExplorerStoreContext();
  const { setCurrentFolderId } = store((s) => ({ setCurrentFolderId: s.setCurrentFolderId }));

  const coreApi = useCoreFileSystem({ setCurrentFolderId });

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
