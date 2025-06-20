import type { DirectoryHandle } from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useState } from 'react';
import { useAdapters } from './adapters-context';
import { isUserCancellation, mapFileSystemError } from './file-system-error-helpers';

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
