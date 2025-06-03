/**
 * Selection Manager Hook (Context-aware)
 *
 * This hook manages file selection state and enforces selection limits.
 * It uses the context-based store instead of the global store.
 */

import { useSelectionManager as useCoreSelectionManager } from '@brainstrike/file-explorer-hooks';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface UseSelectionManagerProps {
  onSelectionLimitExceeded: () => void;
}

export const useSelectionManager = ({ onSelectionLimitExceeded }: UseSelectionManagerProps) => {
  const store = useFileExplorerStoreContext();
  const { selectedFilePaths, maxSelectionCount, setSelectedFiles } = store(
    (s) => ({
      selectedFilePaths: s.selectedFilePaths,
      maxSelectionCount: s.maxSelectionCount,
      setSelectedFiles: s.setSelectedFiles,
    }),
    shallow
  );

  // Pass state and setters from context store to the core hook
  return useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles,
    onSelectionLimitExceeded,
  });
};
