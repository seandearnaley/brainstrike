/**
 * File System Hook (Context-aware)
 *
 * This hook provides file system functionality using the context-based store.
 */

import { useFileSystem as useCoreFileSystem } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

export function useFileSystem() {
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const store = useFileExplorerStoreContext();
  const { setCurrentFolderId } = store();

  const coreApi = useCoreFileSystem({ setCurrentFolderId });

  const isFileSystemAccessSupported = (): {
    supported: boolean;
    reason: string;
  } => {
    return coreApi.isFileSystemAccessSupported();
  };

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
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
        // Handle specific error types with user-friendly messages
        if (error.message.includes('Permission denied')) {
          throw new Error(
            'Permission denied: Unable to access the selected directory. Please check folder permissions and try again.'
          );
        }

        if (error.message.includes('Unable to open directory selection dialog')) {
          throw new Error('Could not open the folder selection dialog. Please try again.');
        }

        if (error.message.includes('Failed to open directory dialog')) {
          throw new Error('Could not open the folder selection dialog. Please try again.');
        }

        if (error.message.includes('Unable to read the selected directory')) {
          throw new Error(
            'Cannot read the selected directory. Please ensure you have proper access permissions.'
          );
        }

        if (error.message.includes('Cannot access selected directory')) {
          throw new Error(
            'Cannot access the selected directory. Please ensure you have proper access permissions.'
          );
        }

        // For any other errors, pass through the message as-is since it's already user-friendly
        throw error;
      }

      // Fallback for non-Error objects
      throw new Error('An unexpected error occurred while selecting the directory.');
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
