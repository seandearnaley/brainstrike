import type { IFileNode } from '@brainstrike/types';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { Checkbox } from '@brainstrike/ui';
import { memoizedFileExplorer as fileExplorer, isPathSelectedInFolder } from '@brainstrike/utils';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

type FileTreeRowProps = {
  node: IFileNode;
  depth: number;
  isExpanded: boolean;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
  isLoading: boolean;
  folderId: string;
  style?: CSSProperties;
  children?: React.ReactNode;
};

const ROW_HEIGHT = 32;

// Custom comparison function for React.memo
const areFileTreeRowPropsEqual = (
  prevProps: FileTreeRowProps,
  nextProps: FileTreeRowProps
): boolean => {
  if (prevProps.children !== nextProps.children) {
    return false;
  }
  // Compare style props (top and paddingLeft)
  if (prevProps.style?.top !== nextProps.style?.top) {
    return false;
  }
  if (prevProps.style?.paddingLeft !== nextProps.style?.paddingLeft) {
    return false;
  }

  // Compare node prop (path)
  // A shallow comparison of the node object itself is also an option if nodes are immutable.
  // For now, comparing by path as it's a primary identifier for changes.
  if (prevProps.node.path !== nextProps.node.path) {
    return false;
  }

  // A more robust check for the node would be a shallow comparison,
  // assuming node objects are replaced if their content changes.
  // if (prevProps.node !== nextProps.node) { // Example of shallow comparison
  //   return false;
  // }

  // Compare other primitive props
  if (
    prevProps.depth !== nextProps.depth ||
    prevProps.isExpanded !== nextProps.isExpanded ||
    prevProps.isLoading !== nextProps.isLoading ||
    prevProps.folderId !== nextProps.folderId
    // maxSelectionCount is not a direct prop of FileTreeRow, so not compared here.
  ) {
    return false;
  }

  // Compare callback props (reference equality)
  if (
    prevProps.onToggleDirectoryExpansion !== nextProps.onToggleDirectoryExpansion ||
    prevProps.onToggleFileSelection !== nextProps.onToggleFileSelection
  ) {
    return false;
  }

  return true;
};

const FileTreeRow = memo<FileTreeRowProps>(
  ({
    node,
    depth,
    isExpanded,
    onToggleDirectoryExpansion,
    onToggleFileSelection,
    isLoading,
    folderId,
    style,
    children,
  }) => {
    const store = useFileExplorerStoreContext();
    const selectedFilePaths = store((s) => s.selectedFilePaths);
    const maxSelectionCount = store((s) => s.maxSelectionCount);
    const addMultipleSelectedFiles = store((s) => s.addMultipleSelectedFiles);
    const removeMultipleSelectedFiles = store((s) => s.removeMultipleSelectedFiles);

    const allFilePaths = useMemo(
      () =>
        node.type === 'directory' ? fileExplorer.getAllFilePathsInDirectory(node) : [node.path],
      [node]
    );

    const folderInfo = useMemo(() => {
      if (node.type !== 'directory') {
        return null;
      }
      return fileExplorer.getFolderFileCount(node);
    }, [node]);

    const selectedCountInDir = useMemo(
      () =>
        allFilePaths.filter((path) =>
          folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, path) : false
        ).length,
      [allFilePaths, folderId, selectedFilePaths]
    );

    const isFileSelected = useMemo(
      () =>
        node.type === 'file'
          ? folderId
            ? isPathSelectedInFolder(selectedFilePaths, folderId, node.path)
            : false
          : false,
      [node.type, node.path, folderId, selectedFilePaths]
    );

    const handleNodeSelection = useCallback(() => {
      if (node.type !== 'directory') {
        onToggleFileSelection(node.path);
        return;
      }
      if (allFilePaths.length === 0) {
        return;
      }
      const isFullySelected = selectedCountInDir === allFilePaths.length;
      if (!isFullySelected) {
        const unselectedPaths = allFilePaths.filter(
          (path) => !(folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, path) : false)
        );
        const availableSlots = maxSelectionCount - selectedFilePaths.size;
        const pathsToSelect = unselectedPaths.slice(0, availableSlots);
        if (pathsToSelect.length > 0) {
          addMultipleSelectedFiles(folderId, pathsToSelect);
        }
      } else if (allFilePaths.length > 0) {
        removeMultipleSelectedFiles(folderId, allFilePaths);
      }
    }, [
      node.type,
      node.path,
      allFilePaths,
      selectedCountInDir,
      selectedFilePaths,
      onToggleFileSelection,
      maxSelectionCount,
      folderId,
      addMultipleSelectedFiles,
      removeMultipleSelectedFiles,
    ]);

    const handleExpansionClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onToggleDirectoryExpansion(node.path);
      },
      [node.path, onToggleDirectoryExpansion]
    );

    const renderIcon = useCallback(() => {
      if (isLoading) {
        return (
          <Loader2
            aria-label={`Loading ${node.name}`}
            className="animate-spin text-blue-500 dark:text-blue-400"
            size={16}
          />
        );
      }
      if (node.type === 'file') {
        return <FileIcon className="text-gray-500 dark:text-gray-400" size={16} />;
      }
      if (node.type === 'directory') {
        return isExpanded ? (
          <FolderOpen className="text-blue-500 dark:text-blue-400" size={16} />
        ) : (
          <Folder className="text-blue-500 dark:text-blue-400" size={16} />
        );
      }
      return null;
    }, [node.type, node.name, isExpanded, isLoading]);

    const checkboxState = useMemo(() => {
      if (node.type === 'file') {
        return isFileSelected;
      }
      if (allFilePaths.length === 0) {
        return false;
      }
      if (selectedCountInDir === 0) {
        return false;
      }
      return selectedCountInDir === allFilePaths.length ? true : 'indeterminate';
    }, [node.type, isFileSelected, allFilePaths, selectedCountInDir]);

    const wouldExceedLimit = useMemo(() => {
      if (node.type === 'file') {
        return !isFileSelected && selectedFilePaths.size >= maxSelectionCount;
      }
      if (!folderInfo) {
        return false;
      }
      const unselectedCount = folderInfo.count - selectedCountInDir;
      return selectedFilePaths.size + unselectedCount > maxSelectionCount;
    }, [
      node.type,
      isFileSelected,
      selectedFilePaths,
      maxSelectionCount,
      folderInfo,
      selectedCountInDir,
    ]);

    return (
      <div
        aria-expanded={node.type === 'directory' ? isExpanded : undefined}
        className="list-none"
        role="treeitem"
        style={style}
        tabIndex={0}
      >
        <div
          className="flex items-center rounded px-2 py-1.5 transition-all duration-150 hover:bg-accent"
          style={{ paddingLeft: depth * 24 + 8 }}
        >
          {/* Chevron button with fixed width for consistent alignment */}
          <div className="mr-2 flex w-4 justify-center">
            {node.type === 'directory' && (
              <button
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`}
                className="flex cursor-pointer items-center justify-center rounded p-0.5 transition-all duration-150 hover:bg-accent"
                data-testid={EXPAND_COLLAPSE_TEST_ID}
                onClick={handleExpansionClick}
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
            )}
          </div>

          {/* Checkbox with precise alignment */}
          <div
            className="mr-2 flex w-4 items-center justify-center"
            title={
              wouldExceedLimit ? `Cannot select more than ${maxSelectionCount} files` : undefined
            }
          >
            <Checkbox
              aria-label={`Select ${node.name}`}
              checked={checkboxState}
              className="h-4 w-4"
              disabled={wouldExceedLimit}
              id={node.path}
              onClick={(e) => {
                e.stopPropagation();
                if (!wouldExceedLimit) {
                  handleNodeSelection();
                }
              }}
            />
          </div>

          {/* File/folder icon with consistent sizing */}
          <div className="mr-2 flex w-4 items-center justify-center">{renderIcon()}</div>

          {/* File/folder name and additional icons */}
          <div className="flex min-w-0 flex-1 items-center">
            {node.isSymbolicLink && (
              <Link2Icon className="mr-1.5 h-4 w-4 flex-shrink-0 text-blue-500" />
            )}
            <span className="truncate text-sm leading-4">{node.name}</span>
            {node.type === 'directory' && node.isDepthTruncated && (
              <MoreHorizontalIcon className="ml-1.5 h-4 w-4 flex-shrink-0 text-gray-500" />
            )}
          </div>
        </div>
        {/* Render children in a nested div if they exist */}
        {isExpanded && children && <div className="">{children}</div>}
      </div>
    );
  },
  areFileTreeRowPropsEqual
);

FileTreeRow.displayName = 'FileTreeRow';
export { ROW_HEIGHT };
export default FileTreeRow;
