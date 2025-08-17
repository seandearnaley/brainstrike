/**
 * Selection Manager Hook (Context-aware)
 *
 * This hook manages file selection state and enforces selection limits.
 * It uses the context-based store instead of the global store.
 */

import { useSelectionManager as useCoreSelectionManager } from '@brainstrike/file-explorer-hooks';
import { useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface UseSelectionManagerProps {
  onSelectionLimitExceeded: () => void;
}

export const useSelectionManager = ({ onSelectionLimitExceeded }: UseSelectionManagerProps) => {
  const store = useFileExplorerStoreContext();
  const [selectedFilePaths, maxSelectionCount, setSelectedFiles] = store(
    (s) => [s.selectedFilePaths, s.maxSelectionCount, s.setSelectedFiles] as const
  );

  const setSelectedFilesStable = useCallback(
    (next: ReadonlySet<string>) => {
      const array = next instanceof Set ? Array.from(next) : Array.from(next);
      setSelectedFiles(new Set(array));
    },
    [setSelectedFiles]
  );

  // Pass stable state view and setter to the core hook
  const core = useCoreSelectionManager({
    selectedFilePaths,
    maxSelectionCount,
    setSelectedFiles: setSelectedFilesStable,
    onSelectionLimitExceeded,
  });

  // Array façade for UI
  const selectedFilesList = useMemo(() => Array.from(selectedFilePaths), [selectedFilePaths]);
  const setSelectedFilesFromList = useCallback(
    (list: readonly string[]) => core.handleSelectionChange(new Set(list)),
    [core.handleSelectionChange]
  );

  return {
    ...core,
    selectedFilesList,
    setSelectedFilesFromList,
  };
};
