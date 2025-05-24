/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */

import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useCallback } from 'react';

interface UseSelectionManagerParams {
  selectedFilePaths: FileExplorerState['selectedFilePaths'];
  maxSelectionCount: FileExplorerState['maxSelectionCount'];
  setSelectedFiles: FileExplorerState['setSelectedFiles'];
  onSelectionLimitExceeded: () => void;
}

export const useSelectionManager = ({
  selectedFilePaths,
  maxSelectionCount,
  setSelectedFiles,
  onSelectionLimitExceeded,
}: UseSelectionManagerParams) => {
  const wouldExceedSelectionLimit = useCallback(
    (newFilePaths: string[]) => {
      const uniqueNewPaths = new Set(newFilePaths);
      const currentCount = selectedFilePaths.size;
      const additionalCount = Array.from(uniqueNewPaths).filter(
        (path) => !selectedFilePaths.has(path)
      ).length;
      return currentCount + additionalCount > maxSelectionCount;
    },
    [selectedFilePaths, maxSelectionCount]
  );

  const handleSelectionChange = useCallback(
    (selectedFiles: Set<string>) => {
      if (wouldExceedSelectionLimit(Array.from(selectedFiles))) {
        onSelectionLimitExceeded();
        return;
      }
      setSelectedFiles(selectedFiles);
    },
    [wouldExceedSelectionLimit, onSelectionLimitExceeded, setSelectedFiles]
  );

  return {
    selectedFilePaths,
    handleSelectionChange,
    wouldExceedSelectionLimit,
  };
};
