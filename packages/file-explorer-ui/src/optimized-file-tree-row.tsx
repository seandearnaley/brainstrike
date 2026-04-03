import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { LightweightCheckbox } from '@brainstrike/ui';
import { memoizedFileExplorer as fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { createLogger } from '@brainstrike/utils/logger';
import {
  countSelectedInDirectory,
  encodeFileSelection,
  isPathSelectedInFolder,
} from '@brainstrike/utils/selection-utils';

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
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';

interface TreeNodeIconProps {
  isExpanded: boolean;
  isLoading: boolean;
  nodeName: string;
  nodeType: IFileNode['type'];
}

function TreeNodeIcon({ isLoading, nodeType, nodeName, isExpanded }: TreeNodeIconProps) {
  if (isLoading) {
    return (
      <Loader2
        aria-label={`Loading ${nodeName}`}
        className="animate-spin text-blue-500 dark:text-blue-400"
        size={16}
      />
    );
  }
  if (nodeType === 'file') {
    return <FileIcon className="text-gray-500 dark:text-gray-400" size={16} />;
  }
  if (nodeType === 'directory') {
    if (isExpanded) {
      return <FolderOpen className="text-blue-500 dark:text-blue-400" size={16} />;
    }
    return <Folder className="text-blue-500 dark:text-blue-400" size={16} />;
  }
  return null;
}

interface OptimizedFileTreeRowProps {
  children?: React.ReactNode;
  depth: number;
  folderId: string;
  /** Whether directory children are currently being loaded (lazy loading) */
  isChildrenLoading?: boolean | undefined;
  isExpanded: boolean;
  isLoading: boolean;
  /** Whether THIS folder is being loaded for recursive selection */
  isLoadingForSelection?: boolean | undefined;
  node: IFileNode;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /** Optional hook for surfacing lazy-load failures to parent UI */
  onLoadChildrenError?: ((error: unknown, nodePath: string) => void) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
  style?: CSSProperties;
}

const ROW_HEIGHT = 32;
const logger = createLogger('OptimizedFileTreeRow');

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
    prevProps.onLoadChildren !== nextProps.onLoadChildren ||
    prevProps.onLoadChildrenError !== nextProps.onLoadChildrenError
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
    onLoadChildrenError,
    onSelectFolderRecursively,
    isLoadingForSelection,
  }) => {
    const store = useFileExplorerStoreContext();

    // Subscribe to actions (stable references)
    const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
    const addMultipleSelectedFiles = useFileExplorerStoreSelector(
      (s) => s.addMultipleSelectedFiles
    );
    const removeMultipleSelectedFiles = useFileExplorerStoreSelector(
      (s) => s.removeMultipleSelectedFiles
    );

    // Extract node properties for stable dependencies
    const {
      path: nodePath,
      type: nodeType,
      children: nodeChildren,
      loadState: nodeLoadState,
    } = node;

    // PERFORMANCE OPTIMIZATION: Path-specific selection selectors
    // Instead of subscribing to the entire selectedFilePaths Set (which causes N² updates),
    // we use selectors that return the specific value we need (boolean/count).
    // Components only re-render when their specific value changes.

    // Memoize the composite key for file selection check
    const compositeKey = useMemo(
      () => (nodeType === 'file' ? encodeFileSelection(folderId, nodePath) : null),
      [nodeType, folderId, nodePath]
    );

    // Selector for file selection - returns boolean, only re-renders when this file's selection changes
    // Zustand compares return values, so this only triggers re-render when the boolean changes
    const isFileSelectedSelector = useMemo(
      () => (state: FileExplorerState) => {
        if (compositeKey === null) {
          return false;
        }
        return state.selectedFilePaths.has(compositeKey);
      },
      [compositeKey]
    );
    const isFileSelected = useFileExplorerStoreSelector(isFileSelectedSelector);

    // PERFORMANCE OPTIMIZATION: Directory selection count via prefix scan
    // Instead of building the full descendant file list (expensive for large directories),
    // we scan the bounded selectedFilePaths set using a prefix match.
    // This is O(maxSelectionCount) instead of O(files in directory subtree).
    const selectedCountSelector = useMemo(
      () => (state: FileExplorerState) => {
        if (nodeType !== 'directory') {
          return 0;
        }
        return countSelectedInDirectory(state.selectedFilePaths, folderId, nodePath);
      },
      [nodeType, folderId, nodePath]
    );
    const selectedCountInDir = useFileExplorerStoreSelector(selectedCountSelector);

    // Selector for current selection size (for limit checking)
    // Zustand compares return values, so this only triggers re-render when size changes
    const selectionSizeSelector = useMemo(
      () => (state: FileExplorerState) => state.selectedFilePaths.size,
      []
    );
    const currentSelectionSize = useFileExplorerStoreSelector(selectionSizeSelector);

    // PERFORMANCE OPTIMIZATION: Per-path selector for rules-mode selection
    // Instead of subscribing to the entire selectionModel object (which causes all rows
    // to re-render when materializedPaths changes), we use a selector that returns a
    // boolean for just this row's path. Zustand compares return values, so only rows
    // whose boolean changes will re-render.
    const isRuleSelectedSelector = useMemo(
      () => (state: FileExplorerState) => {
        if (nodeType !== 'file') {
          return false;
        }
        const model = state.selectionModel;
        if (model.mode !== 'rules') {
          return false;
        }
        return model.materializedPaths ? model.materializedPaths.has(nodePath) : false;
      },
      [nodeType, nodePath]
    );
    const isRuleSelected = useFileExplorerStoreSelector(isRuleSelectedSelector);

    const folderInfo = useMemo(() => {
      if (nodeType !== 'directory') {
        return null;
      }
      return fileExplorer.getFolderFileCount(node);
    }, [nodeType, nodeChildren, nodeLoadState, node]);

    // Memoize checkbox state calculation
    // Uses folderInfo.count (total files in directory) instead of building full path list
    const checkboxState = useMemo(() => {
      if (node.type === 'file') {
        return isFileSelected;
      }
      const totalFiles = folderInfo?.count ?? 0;
      if (totalFiles === 0) {
        return false;
      }
      if (selectedCountInDir === 0) {
        return false;
      }
      return selectedCountInDir === totalFiles ? true : 'indeterminate';
    }, [node.type, isFileSelected, folderInfo, selectedCountInDir]);

    const wouldExceedLimit = useMemo(() => {
      if (node.type === 'file') {
        return !isFileSelected && currentSelectionSize >= maxSelectionCount;
      }
      if (!folderInfo) {
        return false;
      }
      const unselectedCount = folderInfo.count - selectedCountInDir;
      return currentSelectionSize + unselectedCount > maxSelectionCount;
    }, [
      node.type,
      isFileSelected,
      currentSelectionSize,
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

      // PERFORMANCE: Build allFilePaths only on click, not during render
      // This moves the expensive getAllFilePathsInDirectory call from render-time to click-time
      const allFilePaths = fileExplorer.getAllFilePathsInDirectory(node);

      // Fast path: empty directory
      if (allFilePaths.length === 0) {
        return;
      }

      // Get current selection state at callback time (not stale render-time value)
      const currentState = store.getState();
      const currentSelectedPaths = currentState.selectedFilePaths;

      // Compute selected count at click time for accurate comparison
      const currentSelectedCount = countSelectedInDirectory(
        currentSelectedPaths,
        folderId,
        node.path
      );

      const isFullySelected = currentSelectedCount === allFilePaths.length;
      if (isFullySelected) {
        removeMultipleSelectedFiles(folderId, allFilePaths);
      } else {
        const unselectedPaths = allFilePaths.filter(
          (path: string) =>
            !(folderId ? isPathSelectedInFolder(currentSelectedPaths, folderId, path) : false)
        );
        const availableSlots = maxSelectionCount - currentSelectedPaths.size;
        const pathsToSelect = unselectedPaths.slice(0, availableSlots);
        if (pathsToSelect.length > 0) {
          addMultipleSelectedFiles(folderId, pathsToSelect);
        }
      }
    }, [
      node,
      store,
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
          try {
            await onLoadChildren(node.path);
          } catch (error: unknown) {
            if (onLoadChildrenError) {
              onLoadChildrenError(error, node.path);
            } else {
              logger.error('Failed to load directory children before expansion', {
                path: node.path,
                error,
              });
            }
            return;
          }
        }

        onToggleDirectoryExpansion(node.path);
      },
      [
        node.path,
        node.type,
        node.loadState,
        onToggleDirectoryExpansion,
        onLoadChildren,
        onLoadChildrenError,
      ]
    );

    const handleCheckboxChange = useCallback(() => {
      if (!wouldExceedLimit) {
        handleNodeSelection();
      }
    }, [wouldExceedLimit, handleNodeSelection]);

    return (
      <div
        aria-expanded={node.type === 'directory' ? isExpanded : undefined}
        className="list-none"
        role="treeitem"
        style={style}
        tabIndex={0}
      >
        <div
          className="flex items-center rounded py-1.5 transition-colors duration-150 hover:bg-accent"
          style={{ paddingLeft: depth * 20 + 8 }}
        >
          {/* Chevron button with fixed width for consistent alignment */}
          <div className="flex w-6 flex-shrink-0 items-center justify-center">
            {node.type === 'directory' && (
              <button
                aria-label={
                  isChildrenLoading
                    ? `Loading ${node.name} directory`
                    : `${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`
                }
                className="flex cursor-pointer items-center justify-center rounded p-0.5 transition-colors duration-150 hover:bg-accent"
                data-testid={EXPAND_COLLAPSE_TEST_ID}
                disabled={isChildrenLoading}
                onClick={handleExpansionClick}
                type="button"
              >
                {isChildrenLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                ) : isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            )}
          </div>

          {/* Optimized Checkbox with precise alignment */}
          <div
            className="ml-1.5 flex w-4 flex-shrink-0 items-center justify-center"
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
          <div className="ml-1.5 flex w-4 flex-shrink-0 items-center justify-center">
            <TreeNodeIcon
              isExpanded={isExpanded}
              isLoading={isLoading}
              nodeName={node.name}
              nodeType={node.type}
            />
          </div>

          {/* File/folder name and additional icons */}
          <div className="ml-1.5 flex min-w-0 flex-1 items-center">
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
