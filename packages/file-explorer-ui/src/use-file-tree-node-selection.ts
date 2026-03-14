import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { isPathSelectedInFolder } from '@brainstrike/utils/selection-utils';
import { useCallback, useMemo, useState } from 'react';

export interface UseFileTreeNodeSelectionProps {
  folderId: string;
  maxSelectionCount: number;
  node: IFileNode;
  onToggleFileSelection: (path: string) => void;
  selectedFilePaths: Set<string>;
}

export interface FolderInfo {
  count: number;
  isComplete: boolean;
  selectedCount: number;
}

export interface UseFileTreeNodeSelectionReturn {
  checkboxState: boolean | 'indeterminate';
  folderInfo: FolderInfo | null;
  getAllFilePaths: (dirNode: IFileNode) => string[];
  handleNodeSelection: () => void;
  setShowSelectionDialog: React.Dispatch<React.SetStateAction<boolean>>;
  showSelectionDialog: boolean;
  wouldExceedLimit: boolean;
}

export function useFileTreeNodeSelection({
  node,
  folderId,
  selectedFilePaths,
  maxSelectionCount,
  onToggleFileSelection,
}: UseFileTreeNodeSelectionProps): UseFileTreeNodeSelectionReturn {
  const [showSelectionDialog, setShowSelectionDialog] = useState(false);

  const getAllFilePaths = useCallback((dirNode: IFileNode): string[] => {
    if (dirNode.type !== 'directory') {
      return [];
    }
    return (
      dirNode.children?.reduce((paths: string[], child: IFileNode) => {
        if (child.type === 'file') {
          paths.push(child.path);
        } else if (child.type === 'directory') {
          paths.push(...getAllFilePaths(child));
        }
        return paths;
      }, []) ?? []
    );
  }, []);

  const getSelectedCount = useCallback(
    (paths: string[]) =>
      paths.filter((path) => folderId && isPathSelectedInFolder(selectedFilePaths, folderId, path))
        .length,
    [selectedFilePaths, folderId]
  );

  const selectPaths = useCallback(
    (paths: string[]) => {
      for (const path of paths) {
        onToggleFileSelection(path);
      }
    },
    [onToggleFileSelection]
  );

  const handleNodeSelection = useCallback(() => {
    if (node.type !== 'directory') {
      onToggleFileSelection(node.path);
      return;
    }

    const allFilePaths = getAllFilePaths(node);
    if (allFilePaths.length === 0) {
      return;
    }

    const { count } = fileExplorer.getFolderFileCount(node);
    const selectedCount = getSelectedCount(allFilePaths);
    const isFullySelected = selectedCount === allFilePaths.length;

    if (count > 10 && selectedCount === 0) {
      setShowSelectionDialog(true);
      return;
    }

    if (isFullySelected) {
      selectPaths(allFilePaths);
    } else {
      const unselectedPaths = allFilePaths.filter(
        (path) => !(folderId && isPathSelectedInFolder(selectedFilePaths, folderId, path))
      );
      const availableSlots = maxSelectionCount - selectedFilePaths.size;
      selectPaths(unselectedPaths.slice(0, availableSlots));
    }
  }, [
    node,
    onToggleFileSelection,
    getAllFilePaths,
    getSelectedCount,
    selectPaths,
    maxSelectionCount,
    selectedFilePaths,
    folderId,
  ]);

  const checkboxState = useMemo(() => {
    if (node.type === 'file') {
      return folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, node.path) : false;
    }

    const allFilePaths = getAllFilePaths(node);
    if (allFilePaths.length === 0) {
      return false;
    }

    const selectedCount = getSelectedCount(allFilePaths);
    if (selectedCount === 0) {
      return false;
    }

    return selectedCount === allFilePaths.length ? true : 'indeterminate';
  }, [node, getAllFilePaths, getSelectedCount, selectedFilePaths, folderId]);

  const folderInfo = useMemo(() => {
    if (node.type !== 'directory') {
      return null;
    }
    const { count, isComplete } = fileExplorer.getFolderFileCount(node);
    const selectedCount = getSelectedCount(getAllFilePaths(node));
    return { count, isComplete, selectedCount } as FolderInfo;
  }, [node, getAllFilePaths, getSelectedCount]);

  const wouldExceedLimit = useMemo(() => {
    if (node.type === 'file') {
      return (
        !(folderId && isPathSelectedInFolder(selectedFilePaths, folderId, node.path)) &&
        selectedFilePaths.size >= maxSelectionCount
      );
    }
    if (!folderInfo) {
      return false;
    }

    const unselectedCount = folderInfo.count - folderInfo.selectedCount;
    return selectedFilePaths.size + unselectedCount > maxSelectionCount;
  }, [node, selectedFilePaths, maxSelectionCount, folderInfo, folderId]);

  return {
    checkboxState,
    folderInfo,
    showSelectionDialog,
    setShowSelectionDialog,
    handleNodeSelection,
    wouldExceedLimit,
    getAllFilePaths,
  };
}
