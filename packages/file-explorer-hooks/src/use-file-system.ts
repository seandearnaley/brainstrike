import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useState } from 'react';
import { useAdapters } from './adapters-context';

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
}

export function useFileSystem({ setCurrentFolderId }: UseFileSystemParams) {
  const [rootDirectoryHandle, setRootDirectoryHandle] = useState<DirectoryHandle | null>(null);
  const [isAccessLoading, setIsAccessLoading] = useState(false);
  const { fileSystemAdapter } = useAdapters();

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
      if (error instanceof Error) {
        // Handle the new UserCancelledError specifically
        if (error.name === 'UserCancelledError') {
          // User cancelled - this is not an error, just return null
          return null;
        }

        // Handle permission errors
        if (
          error.message.includes('Permission denied') ||
          error.message.includes('SecurityError') ||
          error.message.includes('Cannot access selected directory')
        ) {
          throw new Error('Permission denied: Unable to access the selected directory');
        }

        // Handle other cancellation scenarios (legacy support)
        if (
          error.message.includes('AbortError') ||
          error.message.includes('cancelled') ||
          error.message.includes('User cancelled')
        ) {
          return null;
        }

        // Handle dialog-specific errors
        if (error.message.includes('Failed to open directory dialog')) {
          throw new Error('Unable to open directory selection dialog. Please try again.');
        }

        // Handle file system access errors
        if (error.message.includes('Failed to read directory')) {
          throw new Error(
            'Unable to read the selected directory. Please check permissions and try again.'
          );
        }

        // Pass through other specific error messages as they are already user-friendly
        throw error;
      }

      // Re-throw unknown errors with a generic message
      throw new Error(
        'An unexpected error occurred while selecting the directory. Please try again.'
      );
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
