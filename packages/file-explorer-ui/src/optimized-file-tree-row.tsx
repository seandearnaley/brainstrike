import type { IFileNode } from '@brainstrike/types';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { LightweightCheckbox } from '@brainstrike/ui';
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
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface OptimizedFileTreeRowProps {
  node: IFileNode;
  depth: number;
  isExpanded: boolean;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
  isLoading: boolean;
  folderId: string;
  style?: CSSProperties;
  children?: React.ReactNode;
}

const ROW_HEIGHT = 32;

// Optimized comparison function for React.memo
const areOptimizedFileTreeRowPropsEqual = (
  prevProps: OptimizedFileTreeRowProps,
  nextProps: OptimizedFileTreeRowProps
): boolean => {
  // Fast path: if it's the same object reference, they're equal
  if (prevProps === nextProps) return true;

  // Compare critical props that affect rendering
  if (
    prevProps.node.path !== nextProps.node.path ||
    prevProps.depth !== nextProps.depth ||
    prevProps.isExpanded !== nextProps.isExpanded ||
    prevProps.isLoading !== nextProps.isLoading ||
    prevProps.folderId !== nextProps.folderId ||
    prevProps.children !== nextProps.children
  ) {
    return false;
  }

  // Compare style props (only the ones we care about)
  const prevTop = prevProps.style?.top;
  const nextTop = nextProps.style?.top;
  if (prevTop !== nextTop) return false;

  // Compare callback props (reference equality)
  if (
    prevProps.onToggleDirectoryExpansion !== nextProps.onToggleDirectoryExpansion ||
    prevProps.onToggleFileSelection !== nextProps.onToggleFileSelection
  ) {
    return false;
  }

  return true;
};

const OptimizedFileTreeRow = memo<OptimizedFileTreeRowProps>(
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
    const {
      selectedFilePaths,
      maxSelectionCount,
      addMultipleSelectedFiles,
      removeMultipleSelectedFiles,
    } = store(
      (s) => ({
        selectedFilePaths: s.selectedFilePaths,
        maxSelectionCount: s.maxSelectionCount,
        addMultipleSelectedFiles: s.addMultipleSelectedFiles,
        removeMultipleSelectedFiles: s.removeMultipleSelectedFiles,
      }),
      shallow
    );

    // Memoize expensive calculations
    const allFilePaths = useMemo(
      () =>
        node.type === 'directory' ? fileExplorer.getAllFilePathsInDirectory(node) : [node.path],
      [node]
    );

    const folderInfo = useMemo(() => {
      if (node.type !== 'directory') return null;
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

    // Memoize checkbox state calculation
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
      if (!folderInfo) return false;
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

    // Memoize event handlers
    const handleNodeSelection = useCallback(() => {
      if (node.type !== 'directory') {
        onToggleFileSelection(node.path);
        return;
      }
      if (allFilePaths.length === 0) return;
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

    const handleCheckboxChange = useCallback(() => {
      if (!wouldExceedLimit) {
        handleNodeSelection();
      }
    }, [wouldExceedLimit, handleNodeSelection]);

    // Memoize icon rendering
    const renderIcon = useCallback(() => {
      if (isLoading) {
        return (
          <Loader2
            size={16}
            className="text-blue-500 dark:text-blue-400 animate-spin"
            aria-label={`Loading ${node.name}`}
          />
        );
      }
      if (node.type === 'file') {
        return <FileIcon size={16} className="text-gray-500 dark:text-gray-400" />;
      }
      if (node.type === 'directory') {
        return isExpanded ? (
          <FolderOpen size={16} className="text-blue-500 dark:text-blue-400" />
        ) : (
          <Folder size={16} className="text-blue-500 dark:text-blue-400" />
        );
      }
      return null;
    }, [node.type, node.name, isExpanded, isLoading]);

    return (
      <div
        className="list-none"
        role="treeitem"
        aria-label={node.name}
        aria-expanded={node.type === 'directory' ? isExpanded : undefined}
        tabIndex={0}
        style={style}
      >
        <div
          className="flex items-center py-1.5 px-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          style={{ paddingLeft: depth * 24 + 8 }}
        >
          {/* Chevron button with fixed width for consistent alignment */}
          <div className="w-4 flex justify-center mr-2">
            {node.type === 'directory' && (
              <button
                type="button"
                onClick={handleExpansionClick}
                className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded cursor-pointer transition-colors flex items-center justify-center"
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`}
                data-testid={EXPAND_COLLAPSE_TEST_ID}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
            )}
          </div>

          {/* Optimized Checkbox with precise alignment */}
          <div
            className="flex items-center justify-center w-4 mr-2"
            title={
              wouldExceedLimit ? `Cannot select more than ${maxSelectionCount} files` : undefined
            }
          >
            <LightweightCheckbox
              id={node.path}
              checked={checkboxState}
              disabled={wouldExceedLimit}
              className="h-4 w-4"
              onCheckedChange={handleCheckboxChange}
              aria-label={`Select ${node.name}`}
            />
          </div>

          {/* File/folder icon with consistent sizing */}
          <div className="flex items-center justify-center w-4 mr-2">{renderIcon()}</div>

          {/* File/folder name and additional icons */}
          <div className="flex items-center flex-1 min-w-0">
            {node.isSymbolicLink && (
              <Link2Icon className="mr-1.5 h-4 w-4 text-blue-500 flex-shrink-0" />
            )}
            <span className="truncate text-sm leading-4">{node.name}</span>
            {node.type === 'directory' && node.isDepthTruncated && (
              <MoreHorizontalIcon className="ml-1.5 h-4 w-4 text-gray-500 flex-shrink-0" />
            )}
          </div>
        </div>
        {/* Render children in a nested list if they exist */}
        {isExpanded && children && <fieldset className="m-0 p-0 border-0">{children}</fieldset>}
      </div>
    );
  },
  areOptimizedFileTreeRowPropsEqual
);

OptimizedFileTreeRow.displayName = 'OptimizedFileTreeRow';
export { ROW_HEIGHT };
export default OptimizedFileTreeRow;
