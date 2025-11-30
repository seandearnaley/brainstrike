/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */

import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useCallback } from 'react';

type UseSelectionManagerParams = {
  selectedFilePaths: FileExplorerState['selectedFilePaths'];
  maxSelectionCount: FileExplorerState['maxSelectionCount'];
  setSelectedFiles: FileExplorerState['setSelectedFiles'];
  onSelectionLimitExceeded: () => void;
};

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
      let additionalCount = 0;
      for (const path of uniqueNewPaths) {
        if (!selectedFilePaths.has(path)) {
          additionalCount += 1;
        }
      }
      return currentCount + additionalCount > maxSelectionCount;
    },
    [selectedFilePaths, maxSelectionCount]
  );

  const handleSelectionChange = useCallback(
    (nextSelectedFiles: Set<string>) => {
      const nextArray = Array.from(nextSelectedFiles);
      if (wouldExceedSelectionLimit(nextArray)) {
        onSelectionLimitExceeded();
        return;
      }
      setSelectedFiles(new Set(nextArray));
    },
    [wouldExceedSelectionLimit, onSelectionLimitExceeded, setSelectedFiles]
  );

  return {
    selectedFilePaths,
    handleSelectionChange,
    wouldExceedSelectionLimit,
  };
};
