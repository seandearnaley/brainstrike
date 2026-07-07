/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */

import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useCallback } from 'react';

interface UseSelectionManagerParams {
  maxSelectionCount: FileExplorerState['maxSelectionCount'];
  selectedFilePaths: FileExplorerState['selectedFilePaths'];
  setSelectedFiles: FileExplorerState['setSelectedFiles'];
}

export const useSelectionManager = ({
  selectedFilePaths,
  maxSelectionCount,
  setSelectedFiles,
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
      if (nextSelectedFiles.size <= maxSelectionCount) {
        setSelectedFiles(new Set(nextSelectedFiles));
        return;
      }

      const clipped = new Set<string>();
      for (const path of nextSelectedFiles) {
        if (clipped.size >= maxSelectionCount) {
          break;
        }
        clipped.add(path);
      }
      setSelectedFiles(clipped);
    },
    [maxSelectionCount, setSelectedFiles]
  );

  return {
    handleSelectionChange,
    selectedFilePaths,
    wouldExceedSelectionLimit,
  };
};
