import { useToastManager } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { useCallback, useState } from 'react';

interface UseFileExplorerToastsParams {
  cancelOperation: () => void;
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  refreshFileExplorer: () => Promise<void>;
  rootDirectoryHandle: DirectoryHandle | null;
}

export function useFileExplorerToasts({
  rootDirectoryHandle,
  refreshFileExplorer,
  handleRootDirectorySelect,
  isFileSystemAccessSupported,
  cancelOperation,
}: UseFileExplorerToastsParams) {
  const {
    toast,
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
  } = useToastManager();

  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (!rootDirectoryHandle) {
      return;
    }

    setIsRefreshing(true);
    try {
      await refreshFileExplorer();
      showToast({
        description: FileExplorerStrings.success.refreshSuccess,
        title: FileExplorerStrings.success.title,
      });
    } catch (error) {
      handleRefreshError(error);
    } finally {
      setIsRefreshing(false);
    }
  }, [rootDirectoryHandle, refreshFileExplorer, showToast, handleRefreshError]);

  const handleDirectorySelect = useCallback(async () => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      handleBrowserCompatibilityError(reason);
      return;
    }

    try {
      const handle = await handleRootDirectorySelect();
      if (handle === null) {
      }
    } catch (error) {
      handleDirectorySelectError(error);
    }
  }, [
    handleRootDirectorySelect,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    isFileSystemAccessSupported,
  ]);

  const handleCancelOperation = useCallback(() => {
    cancelOperation();
    showToast({
      description: 'The file loading operation has been cancelled.',
      title: 'Operation Cancelled',
      variant: 'default',
    });
  }, [cancelOperation, showToast]);

  return {
    handleBrowserCompatibilityError,
    handleCancelOperation,
    handleDirectorySelect,
    handleDirectorySelectError,
    handleRefresh,
    handleRefreshError,
    isRefreshing,
    showToast,
    toast,
  };
}
