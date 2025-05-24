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
        if (
          error.message.includes('Permission denied') ||
          error.message.includes('SecurityError')
        ) {
          throw new Error('Permission denied');
        }
        if (error.message.includes('AbortError') || error.message.includes('cancelled')) {
          return null;
        }
      }
      throw error;
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
