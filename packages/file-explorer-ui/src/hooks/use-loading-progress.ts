import { FileExplorerStrings } from '@brainstrike/types';
import { useMemo } from 'react';
import type { LoadingProgressState } from '../loading-overlay';
import { formatTrailingPathSegments } from '../utils/path-display';

/**
 * Get depth-based progress message when depthProgress is available
 */
const getDepthProgressMessage = (progressState: LoadingProgressState): string => {
  const { depthProgress, currentPath } = progressState;

  if (!depthProgress) {
    return getPercentageProgressMessage(progressState);
  }

  const { currentDepth, maxDepthSeen, estimatedMaxDepth, filesFound, directoriesCompleted } =
    depthProgress;

  // Primary line: depth scanning status
  let depthLabel: string;
  if (maxDepthSeen >= 2) {
    // Only show estimate after seeing depth 2+
    depthLabel = `Scanning depth ${currentDepth} of ~${estimatedMaxDepth}`;
  } else {
    depthLabel = `Scanning depth ${currentDepth}...`;
  }

  // Secondary line: stats
  const statsLine = `Found ${filesFound.toLocaleString()} files in ${directoriesCompleted} directories`;

  // Third line: current path (if available)
  if (currentPath) {
    const displayPath = formatTrailingPathSegments(currentPath);
    return `${depthLabel}\n${statsLine}\n${displayPath}`;
  }

  return `${depthLabel}\n${statsLine}`;
};

/**
 * Get progress message with percentage (fallback when depthProgress not available)
 */
const getPercentageProgressMessage = (progressState: LoadingProgressState): string => {
  const { loaded, total, currentPath } = progressState;

  if (total === 0) {
    return 'Preparing...';
  }

  const percent = Math.round((loaded / total) * 100);
  const baseMsg = `Processing files (${loaded}/${total} - ${percent}%)`;

  if (currentPath) {
    const displayPath = formatTrailingPathSegments(currentPath);
    return `${baseMsg}\n${displayPath}`;
  }

  return baseMsg;
};

/**
 * Get the base message without cancelling or custom message
 */
const getBaseMessage = (isInitialLoad?: boolean, progressState?: LoadingProgressState): string => {
  if (isInitialLoad && !progressState) {
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

  // Use depth-based progress message when available
  return getDepthProgressMessage(progressState);
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

    // When we have depth progress, the description can be simpler
    // since stats are shown in the main message
    if (progressState.depthProgress) {
      return 'Files appear as they are discovered';
    }

    return FileExplorerStrings.prompts.waitForLoading;
  }, [isCancelling, description, progressState]);
