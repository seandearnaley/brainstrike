import { FileExplorerStrings } from '@brainstrike/types';
import { useMemo } from 'react';
import type { LoadingProgressState } from '../loading-overlay';

export const useProgressMessage = (
  isCancelling: boolean,
  message?: string,
  isInitialLoad?: boolean,
  progressState?: LoadingProgressState
) => {
  return useMemo(() => {
    if (isCancelling) {
      return 'Cancelling operation...';
    }

    if (message) return message;

    if (isInitialLoad) {
      return FileExplorerStrings.loading.rootDirectory;
    }

    if (!progressState) {
      return isInitialLoad
        ? FileExplorerStrings.loading.rootDirectory
        : FileExplorerStrings.loading.refreshing;
    }

    if (progressState.phase === 'counting') {
      return 'Scanning directory structure...';
    }

    const { loaded, total, currentPath } = progressState;

    if (total === 0) return 'Preparing...';

    const percent = Math.round((loaded / total) * 100);
    const baseMsg = `Processing files (${loaded}/${total} - ${percent}%)`;

    if (currentPath) {
      // Get the last 2 parts of the path for display
      const parts = currentPath.split('/');
      const displayPath = parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : currentPath;
      return `${baseMsg}\n${displayPath}`;
    }

    return baseMsg;
  }, [isCancelling, message, isInitialLoad, progressState]);
};

export const useProgressDescription = (
  isCancelling: boolean,
  description?: string,
  progressState?: LoadingProgressState
) => {
  return useMemo(() => {
    if (isCancelling) {
      return 'Please wait while the operation is safely cancelled...';
    }

    if (description) return description;
    if (!progressState) {
      return FileExplorerStrings.prompts.waitForLoading;
    }
    if (progressState.phase === 'counting') {
      return 'This may take a moment for large directories';
    }
    return FileExplorerStrings.prompts.waitForLoading;
  }, [isCancelling, description, progressState]);
};
