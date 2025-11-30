import type { IFileNode } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import { useSelectionManager } from '../use-selection-manager-context';

type UseFileExplorerSelectionParams = {
  quickFilteredTree: IFileNode[] | null;
  onSelectionLimitExceeded: () => void;
};

export function useFileExplorerSelection({
  quickFilteredTree,
  onSelectionLimitExceeded,
}: UseFileExplorerSelectionParams) {
  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded,
  });

  const [displayedFiles, setDisplayedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (quickFilteredTree) {
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
      setDisplayedFiles(allVisibleFiles);
    }
  }, [quickFilteredTree]);

  return {
    selectedFilePaths,
    handleSelectionChange,
    displayedFiles,
  };
}
