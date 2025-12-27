import { FileExplorerStrings } from '@brainstrike/types';
import { useMemo } from 'react';
import type { LoadingProgressState } from '../loading-overlay';

/**
 * Format path for display by showing only the last 2 parts
 */
const formatDisplayPath = (currentPath: string): string => {
  const parts = currentPath.split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : currentPath;
};

/**
 * Get the base message without cancelling or custom message
 */
const getBaseMessage = (isInitialLoad?: boolean, progressState?: LoadingProgressState): string => {
  if (isInitialLoad) {
    return FileExplorerStrings.loading.rootDirectory;
  }

  if (!progressState) {
    return isInitialLoad
      ? FileExplorerStrings.loading.rootDirectory
      : FileExplorerStrings.loading.refreshing;
  }

  if (progressState.phase === 'counting') {
    return 'Scanning folders...';
  }

  return getProgressMessage(progressState);
};

/**
 * Get progress message with percentage and optional path
 */
const getProgressMessage = (progressState: LoadingProgressState): string => {
  const { loaded, total, currentPath, percentage } = progressState;

  if (total === 0) {
    return 'Preparing...';
  }

  // Use the monotonically increasing percentage (never goes backwards)
  const displayPercent = percentage ?? Math.round((loaded / total) * 100);
  const baseMsg = `Processing files (${loaded}/${total} - ${displayPercent}%)`;

  if (currentPath) {
    const displayPath = formatDisplayPath(currentPath);
    return `${baseMsg}\n${displayPath}`;
  }

  return baseMsg;
};

export const useProgressMessage = (
  isCancelling: boolean,
  message?: string,
  isInitialLoad?: boolean,
  progressState?: LoadingProgressState
) =>
  useMemo(() => {
    if (isCancelling) {
      return 'Cancelling operation...';
    }

    if (message) {
      return message;
    }

    return getBaseMessage(isInitialLoad, progressState);
  }, [isCancelling, message, isInitialLoad, progressState]);

export const useProgressDescription = (
  isCancelling: boolean,
  description?: string,
  progressState?: LoadingProgressState
) =>
  useMemo(() => {
    if (isCancelling) {
      return 'Please wait while the operation is safely cancelled...';
    }

    if (description) {
      return description;
    }
    if (!progressState) {
      return FileExplorerStrings.prompts.waitForLoading;
    }
    if (progressState.phase === 'counting') {
      return 'This may take a moment for large directories';
    }
    return FileExplorerStrings.prompts.waitForLoading;
  }, [isCancelling, description, progressState]);
