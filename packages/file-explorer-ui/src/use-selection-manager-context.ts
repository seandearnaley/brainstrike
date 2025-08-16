/**
 * Selection Manager Hook (Context-aware)
 *
 * This hook manages file selection state and enforces selection limits.
 * It uses the context-based store instead of the global store.
 */

import { useSelectionManager as useCoreSelectionManager } from '@brainstrike/file-explorer-hooks';
import { useCallback, useEffect, useRef } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface UseSelectionManagerProps {
  onSelectionLimitExceeded: () => void;
}

export const useSelectionManager = ({ onSelectionLimitExceeded }: UseSelectionManagerProps) => {
  'use no memo';
  const store = useFileExplorerStoreContext();
  const [selectedFilePaths, maxSelectionCount, setSelectedFiles] = store(
    (s) => [s.selectedFilePaths, s.maxSelectionCount, s.setSelectedFiles] as const
  );

  // Stabilize setter identity across HMR/render cycles
  const setSelectedRef = useRef(setSelectedFiles);
  useEffect(() => {
    setSelectedRef.current = setSelectedFiles;
  }, [setSelectedFiles]);
  const setSelectedFilesStable = useCallback((next: ReadonlySet<string>) => {
    // Convert to mutable Set for the store setter while preserving values
    setSelectedRef.current(new Set(next));
  }, []);

  // Pass stable state view and setter to the core hook
  return useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles: setSelectedFilesStable,
    onSelectionLimitExceeded,
  });
};
