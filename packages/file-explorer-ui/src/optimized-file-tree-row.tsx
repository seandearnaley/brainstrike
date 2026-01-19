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
  Sparkles,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo } from 'react';
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
  /** Whether directory children are currently being loaded (lazy loading) */
  isChildrenLoading?: boolean | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  /** Whether THIS folder is being loaded for recursive selection */
  isLoadingForSelection?: boolean | undefined;
}

const ROW_HEIGHT = 32;

// Optimized comparison function for React.memo
const areOptimizedFileTreeRowPropsEqual = (
  prevProps: OptimizedFileTreeRowProps,
  nextProps: OptimizedFileTreeRowProps
): boolean => {
  // Fast path: if it's the same object reference, they're equal
  if (prevProps === nextProps) {
    return true;
  }

  // Compare critical props that affect rendering
  if (
    prevProps.node.path !== nextProps.node.path ||
    prevProps.node.loadState !== nextProps.node.loadState ||
    prevProps.node.children !== nextProps.node.children ||
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
  if (prevTop !== nextTop) {
    return false;
  }

  // Compare callback props (reference equality)
  if (
    prevProps.onToggleDirectoryExpansion !== nextProps.onToggleDirectoryExpansion ||
    prevProps.onToggleFileSelection !== nextProps.onToggleFileSelection ||
    prevProps.onLoadChildren !== nextProps.onLoadChildren
  ) {
    return false;
  }

  // Compare lazy loading state
  if (prevProps.isChildrenLoading !== nextProps.isChildrenLoading) {
    return false;
  }

  // Compare recursive selection props
  if (prevProps.onSelectFolderRecursively !== nextProps.onSelectFolderRecursively) {
    return false;
  }
  if (prevProps.isLoadingForSelection !== nextProps.isLoadingForSelection) {
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
    isChildrenLoading,
    onLoadChildren,
    onSelectFolderRecursively,
    isLoadingForSelection,
  }) => {
    const store = useFileExplorerStoreContext();
    const selectedFilePaths = store((s) => s.selectedFilePaths);
    const maxSelectionCount = store((s) => s.maxSelectionCount);
    const addMultipleSelectedFiles = store((s) => s.addMultipleSelectedFiles);
    const removeMultipleSelectedFiles = store((s) => s.removeMultipleSelectedFiles);
    const selectionModel = store((s) => s.selectionModel);

    // Check if this file is selected by rules (in rules mode with materialized paths)
    const isRuleSelected = useMemo(() => {
      if (node.type !== 'file') {
        return false;
      }
      if (selectionModel.mode !== 'rules') {
        return false;
      }
      if (!selectionModel.materializedPaths) {
        return false;
      }
      return selectionModel.materializedPaths.has(node.path);
    }, [node.type, node.path, selectionModel.mode, selectionModel.materializedPaths]);

    // Memoize expensive calculations
    // Note: we include node.children and node.loadState as dependencies so this
    // recalculates when children are loaded (e.g., during recursive folder selection)
    const allFilePaths = useMemo(
      () =>
        node.type === 'directory' ? fileExplorer.getAllFilePathsInDirectory(node) : [node.path],
      [node, node.children, node.loadState]
    );

    const folderInfo = useMemo(() => {
      if (node.type !== 'directory') {
        return null;
      }
      return fileExplorer.getFolderFileCount(node);
    }, [node, node.children, node.loadState]);

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

    // Memoize event handlers
    const handleNodeSelection = useCallback(() => {
      if (node.type !== 'directory') {
        onToggleFileSelection(node.path);
        return;
      }

      // For directories that aren't fully loaded, use recursive selection
      // This will load all children first, then select them
      const needsRecursiveLoad =
        node.loadState !== 'loaded' ||
        (node.children?.some((c) => c.type === 'directory' && c.loadState !== 'loaded') ?? false);

      if (needsRecursiveLoad && onSelectFolderRecursively) {
        // Use async recursive selection - the hook handles everything
        void onSelectFolderRecursively(node);
        return;
      }

      // Fast path: folder is fully loaded, use existing logic
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
      node,
      allFilePaths,
      selectedCountInDir,
      selectedFilePaths,
      onToggleFileSelection,
      maxSelectionCount,
      folderId,
      addMultipleSelectedFiles,
      removeMultipleSelectedFiles,
      onSelectFolderRecursively,
    ]);

    const handleExpansionClick = useCallback(
      async (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();

        // For lazy loading: if directory children haven't been loaded yet, load them first
        // Check loadState rather than children because adapters may set children: [] initially
        const needsLoad =
          node.type === 'directory' &&
          (node.loadState === 'unloaded' || node.loadState === undefined) &&
          onLoadChildren;

        if (needsLoad) {
          await onLoadChildren(node.path);
        }

        onToggleDirectoryExpansion(node.path);
      },
      [node.path, node.type, node.loadState, onToggleDirectoryExpansion, onLoadChildren]
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
                aria-label={
                  isChildrenLoading
                    ? `Loading ${node.name} directory`
                    : `${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`
                }
                className="flex cursor-pointer items-center justify-center rounded p-0.5 transition-all duration-150 hover:bg-accent"
                data-testid={EXPAND_COLLAPSE_TEST_ID}
                disabled={isChildrenLoading}
                onClick={handleExpansionClick}
                type="button"
              >
                {isChildrenLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                ) : isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
            )}
          </div>

          {/* Optimized Checkbox with precise alignment */}
          <div
            className="mr-2 flex w-4 items-center justify-center"
            title={
              isLoadingForSelection
                ? 'Loading folder contents...'
                : wouldExceedLimit
                  ? `Cannot select more than ${maxSelectionCount} files`
                  : undefined
            }
          >
            {isLoadingForSelection ? (
              <Loader2
                aria-label={`Loading ${node.name} for selection`}
                className="h-4 w-4 animate-spin text-blue-500"
              />
            ) : (
              <LightweightCheckbox
                aria-label={`Select ${node.name}`}
                checked={checkboxState}
                className="h-4 w-4"
                disabled={wouldExceedLimit}
                id={node.path}
                onCheckedChange={handleCheckboxChange}
              />
            )}
          </div>

          {/* File/folder icon with consistent sizing */}
          <div className="mr-2 flex w-4 items-center justify-center">{renderIcon()}</div>

          {/* File/folder name and additional icons */}
          <div className="flex min-w-0 flex-1 items-center">
            {node.isSymbolicLink && (
              <Link2Icon className="mr-1.5 h-4 w-4 flex-shrink-0 text-blue-500" />
            )}
            <span className="truncate text-sm leading-4">{node.name}</span>
            {isRuleSelected && (
              <Sparkles
                aria-label="Selected by rule"
                className="ml-1.5 h-3.5 w-3.5 flex-shrink-0 text-amber-500 dark:text-amber-400"
              />
            )}
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
  areOptimizedFileTreeRowPropsEqual
);

OptimizedFileTreeRow.displayName = 'OptimizedFileTreeRow';
export { ROW_HEIGHT };
export default OptimizedFileTreeRow;
