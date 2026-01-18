/**
 * File System Hook (Context-aware)
 *
 * This hook provides file system functionality using the context-based store.
 */

import { useFileSystem as useCoreFileSystem } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { useEffect, useMemo } from 'react';
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
} as const satisfies Record<string, string>;

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
] as const satisfies ReadonlyArray<{ pattern: RegExp; message: string }>;

// Helper function to map error messages to user-friendly text
function getUserFriendlyErrorMessage(errorMessage: string): string {
  const matchedPattern = ERROR_PATTERNS.find(({ pattern }) => pattern.test(errorMessage));
  return matchedPattern ? matchedPattern.message : errorMessage;
}

// Wrapper: error mapping only (no extra state/hooks)
async function selectDirectoryWithErrorMapping(
  coreApi: ReturnType<typeof useCoreFileSystem>
): Promise<DirectoryHandle | null> {
  const { supported, reason } = coreApi.isFileSystemAccessSupported();
  if (!supported) {
    throw new Error(reason);
  }
  try {
    return await coreApi.selectRootDirectory();
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? getUserFriendlyErrorMessage(error.message)
        : ERROR_MESSAGES.genericError;
    throw new Error(errorMessage);
  }
}

export function useFileSystem() {
  const store = useFileExplorerStoreContext();
  const setCurrentFolderId = store((s) => s.setCurrentFolderId);
  const storedRootDirectoryHandle = store((s) => s.rootDirectoryHandle);
  const setRootDirectoryHandle = store((s) => s.setRootDirectoryHandle);

  const coreApi = useCoreFileSystem({ setCurrentFolderId });

  const isFileSystemAccessSupported = coreApi.isFileSystemAccessSupported;

  const selectRootDirectory = async (): Promise<DirectoryHandle | null> => {
    const handle = await selectDirectoryWithErrorMapping(coreApi);
    if (handle) {
      setRootDirectoryHandle(handle);
    }
    return handle;
  };

  const clearRootDirectory = () => {
    coreApi.clearRootDirectory();
    setRootDirectoryHandle(null);
  };

  /**
   * Set root directory handle from external source (e.g., restore banner).
   * Updates both the store and the core hook's internal state.
   */
  const setRootHandle = (handle: DirectoryHandle | null) => {
    coreApi.setRootDirectoryHandle(handle);
    setRootDirectoryHandle(handle);
  };

  // Sync core hook's restoration to the store (desktop auto-restore)
  // Initial one-way sync only: if the core restored a handle and the store is empty.
  // biome-ignore lint/plugin: One-time sync from core hook to store - controlled state restoration
  useEffect(() => {
    if (!storedRootDirectoryHandle && coreApi.rootDirectoryHandle) {
      setRootDirectoryHandle(coreApi.rootDirectoryHandle);
    }
  }, [storedRootDirectoryHandle, coreApi.rootDirectoryHandle, setRootDirectoryHandle]);

  // Memoize the return object with stable primitive/reference dependencies only
  // Functions are recreated each render but the object identity changes only when
  // the actual data values change
  return useMemo(
    () => ({
      rootDirectoryHandle: storedRootDirectoryHandle ?? coreApi.rootDirectoryHandle,
      isAccessLoading: coreApi.isAccessLoading,
      selectRootDirectory,
      isFileSystemAccessSupported,
      clearRootDirectory,
      setRootDirectoryHandle: setRootHandle,
      setAccessLoading: coreApi.setAccessLoading,
    }),
    // Only depend on data values, not functions - functions are stable closures
    // that reference the latest values through the closure scope
    [storedRootDirectoryHandle, coreApi.rootDirectoryHandle, coreApi.isAccessLoading]
  );
}
