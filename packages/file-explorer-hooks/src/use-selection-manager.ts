/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */

import type { FileExplorerState } from '@brainstrike/types'; // Import the state type
import { useCallback, useEffect, useRef } from 'react';

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
  // Keep a stable ref to the current selection to avoid capturing changing Set identities in deps
  const selectedRef = useRef(selectedFilePaths);
  useEffect(() => {
    selectedRef.current = selectedFilePaths;
  }, [selectedFilePaths]);

  const wouldExceedSelectionLimit = useCallback(
    (newFilePaths: string[]) => {
      const uniqueNewPaths = new Set(newFilePaths);
      const currentSelected = selectedRef.current;
      const currentCount = currentSelected.size;
      let additionalCount = 0;
      for (const path of uniqueNewPaths) {
        if (!currentSelected.has(path)) additionalCount += 1;
      }
      return currentCount + additionalCount > maxSelectionCount;
    },
    [maxSelectionCount]
  );

  const handleSelectionChange = useCallback(
    (nextSelectedFiles: Set<string>) => {
      if (wouldExceedSelectionLimit(Array.from(nextSelectedFiles))) {
        onSelectionLimitExceeded();
        return;
      }
      setSelectedFiles(nextSelectedFiles);
    },
    [wouldExceedSelectionLimit, onSelectionLimitExceeded, setSelectedFiles]
  );

  return {
    selectedFilePaths,
    handleSelectionChange,
    wouldExceedSelectionLimit,
  };
};
