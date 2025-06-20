import type { DirectoryHandle } from '@brainstrike/file-system';
import {
  isAccessError,
  isDialogError,
  isPermissionError,
  isUserCancelledError,
} from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useState } from 'react';
import { useAdapters } from './adapters-context';

interface UseFileSystemParams {
  setCurrentFolderId: FileExplorerState['setCurrentFolderId'];
}

/**
 * Handles specific file system errors and converts them to user-friendly messages
 * Returns undefined if the error should be handled by generic error handling
 */
function handleFileSystemError(error: unknown): Error | null | undefined {
  // Handle user cancellation - not an error, just return null
  if (isUserCancelledError(error)) {
    return null;
  }

  // Handle permission errors with user-friendly messages
  if (isPermissionError(error)) {
    return new Error('Permission denied: Unable to access the selected directory');
  }

  // Handle access errors (file/directory read/write issues)
  if (isAccessError(error)) {
    return new Error(
      'Unable to access the selected directory. Please check permissions and try again.'
    );
  }

  // Handle dialog errors
  if (isDialogError(error)) {
    return new Error('Unable to open directory selection dialog. Please try again.');
  }

  return undefined; // Continue to generic error handling
}

/**
 * Handles generic errors including abort operations
 */
function handleGenericError(error: unknown): Error | null {
  if (error instanceof Error) {
    // Check for proper DOMException abort errors first
    if (error.name === 'AbortError') {
      return null;
    }

    // Legacy error handling for backward compatibility
    if (
      error.message.includes('AbortError') ||
      error.message.includes('cancelled') ||
      error.message.includes('User cancelled')
    ) {
      return null;
    }

    // Pass through other specific error messages as they are already user-friendly
    return error;
  }

  // Re-throw unknown errors with a generic message
  return new Error('An unexpected error occurred while selecting the directory. Please try again.');
}

/**
 * Processes errors from directory selection and returns appropriate error or null
 */
function processDirectorySelectionError(error: unknown): Error | null {
  const specificError = handleFileSystemError(error);
  if (specificError !== undefined) {
    return specificError;
  }

  return handleGenericError(error);
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
      const processedError = processDirectorySelectionError(error);
      if (processedError) {
        throw processedError;
      }
      return null;
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
