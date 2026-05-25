import type { IFileNode } from '@brainstrike/types';
import { useMemo } from 'react';
import { useSelectionManager } from '../shell/use-selection-manager-context';

interface UseFileExplorerSelectionParams {
  quickFilteredTree: IFileNode[] | null;
}

export function useFileExplorerSelection({ quickFilteredTree }: UseFileExplorerSelectionParams) {
  const { selectedFilePaths, handleSelectionChange } = useSelectionManager();

  // Derive displayed files from filtered tree using useMemo instead of useEffect
  const displayedFiles = useMemo(() => {
    if (!quickFilteredTree) {
      return new Set<string>();
    }
    const allVisibleFiles = new Set<string>();
    const stack = [...quickFilteredTree];
    while (stack.length > 0) {
      const node = stack.pop() as IFileNode;
      if (node.type === 'file' && node.isVisible !== false) {
        allVisibleFiles.add(node.path);
      } else if (node.type === 'directory' && node.children) {
        stack.push(...node.children);
      }
    }
    return allVisibleFiles;
  }, [quickFilteredTree]);

  return {
    selectedFilePaths,
    handleSelectionChange,
    displayedFiles,
  };
}
