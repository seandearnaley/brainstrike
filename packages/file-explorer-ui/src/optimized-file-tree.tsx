import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import OptimizedFileTreeRow, { ROW_HEIGHT } from './optimized-file-tree-row';
import { useVirtualList } from './use-virtual-list';

interface IOptimizedFileTreeProps {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
  /** Set of directory paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string> | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean | undefined;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null | undefined;
}

/**
 * @file OptimizedFileTree.tsx
 * @description Optimized version of FileTree with performance improvements for large directory structures.
 *
 * Key optimizations:
 * - Uses LightweightCheckbox instead of ShadCN checkbox
 * - Improved memoization strategies
 * - Optimized React.memo comparison functions
 * - Reduced context provider overhead
 * - Enhanced virtualization with better scroll performance
 *
 * @param {IFileNode[]} fileTree - The array of IFileNode objects representing the file structure to render.
 * @param {Set<string>} loadingFiles - A set of paths for files that are currently in a loading state.
 * @param {(() => void) | undefined} onRender - An optional callback function that is triggered when the tree component renders (primarily for testing).
 * @param {string} folderId - The identifier for the current folder context, used for selection and expansion state.
 */
const OptimizedFileTree = memo<IOptimizedFileTreeProps>(
  ({
    fileTree,
    loadingFiles,
    onRender,
    folderId,
    loadingPaths,
    onLoadChildren,
    cancelChildLoading,
    onSelectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
  }) => {
    const store = useFileExplorerStoreContext();
    const expandedDirectoryPaths = store((s) => s.expandedDirectoryPaths);
    const toggleDirectoryExpansion = store((s) => s.toggleDirectoryExpansion);
    const toggleSelectedFile = store((s) => s.toggleSelectedFile);

    /**
     * Wrapped toggle that cancels streaming loads on collapse.
     * When a directory is currently loading and the user collapses it,
     * we abort the streaming operation to avoid wasted work.
     */
    const handleToggleDirectoryExpansion = useCallback(
      (path: string) => {
        // Check if we're collapsing (path is currently expanded) and loading
        const isExpanded = expandedDirectoryPaths.has(path);
        const isLoading = loadingPaths?.has(path);

        if (isExpanded && isLoading && cancelChildLoading) {
          // Cancel the in-flight streaming load before collapsing
          cancelChildLoading(path);
        }

        // Proceed with the toggle
        toggleDirectoryExpansion(path);
      },
      [expandedDirectoryPaths, loadingPaths, cancelChildLoading, toggleDirectoryExpansion]
    );

    // Immediate file selection for better responsiveness
    const handleToggleFileSelection = useCallback(
      (path: string) => {
        if (!folderId) {
          return;
        }
        toggleSelectedFile(folderId, path);
      },
      [folderId, toggleSelectedFile]
    );

    // Optimized tree flattening with better memoization
    const flattenTree = useCallback(
      (nodes: IFileNode[], depth = 0, acc: { node: IFileNode; depth: number }[] = []) => {
        for (const n of nodes) {
          acc.push({ node: n, depth });
          if (
            n.type === 'directory' &&
            expandedDirectoryPaths.has(n.path) &&
            n.loadState === 'loaded' &&
            n.children
          ) {
            flattenTree(
              n.children.filter((c) => c.isVisible !== false),
              depth + 1,
              acc
            );
          }
        }
        return acc;
      },
      [expandedDirectoryPaths]
    );

    // Memoize visible nodes calculation
    const visibleNodes = useMemo(() => flattenTree(fileTree), [fileTree, flattenTree]);

    // Enhanced virtualization with improved performance
    const { containerRef, range, totalHeight } = useVirtualList(
      visibleNodes.length,
      ROW_HEIGHT,
      { overscan: 2 } // Reduced overscan to decrease memory usage
    );

    // Optimized row rendering with better memoization
    const renderedRows = useMemo(() => {
      const startIndex = range.start;
      const endIndex = range.end;
      const rows = [];

      for (let i = startIndex; i <= endIndex; i++) {
        const item = visibleNodes[i];
        if (!item) {
          continue;
        }

        const { node, depth } = item;

        rows.push(
          <OptimizedFileTreeRow
            depth={depth}
            folderId={folderId}
            isChildrenLoading={loadingPaths?.has(node.path) ?? false}
            isExpanded={expandedDirectoryPaths.has(node.path) && node.loadState === 'loaded'}
            isLoading={
              folderId ? loadingFiles.has(encodeFileSelection(folderId, node.path)) : false
            }
            isLoadingForSelection={isLoadingForSelection && loadingPathForSelection === node.path}
            key={node.path}
            node={node}
            onLoadChildren={onLoadChildren}
            onSelectFolderRecursively={onSelectFolderRecursively}
            onToggleDirectoryExpansion={handleToggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            style={{
              position: 'absolute',
              top: i * ROW_HEIGHT,
              width: '100%',
              height: ROW_HEIGHT,
            }}
          />
        );
      }

      return rows;
    }, [
      visibleNodes,
      range.start,
      range.end,
      expandedDirectoryPaths,
      handleToggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
      loadingPaths,
      onLoadChildren,
      onSelectFolderRecursively,
      isLoadingForSelection,
      loadingPathForSelection,
    ]);

    // This effect will run if the onRender callback itself changes.
    useEffect(() => {
      onRender?.();
    }, [onRender]);

    // No cleanup needed anymore

    return (
      <div
        className="relative h-full min-h-0 flex-1 overflow-y-auto"
        data-testid="file-tree-scroll-container"
        ref={containerRef}
      >
        <div
          aria-label="File tree"
          className="file-tree relative"
          data-testid="file-tree"
          role="tree"
          style={{ height: totalHeight }}
        >
          {renderedRows}
        </div>
      </div>
    );
  }
);

OptimizedFileTree.displayName = 'OptimizedFileTree';

// Lightweight memoization: rely on reference equality to avoid O(n) comparisons
const OptimizedFileTreeMemoized = memo(OptimizedFileTree, (prevProps, nextProps) => {
  if (prevProps.folderId !== nextProps.folderId) {
    return false;
  }
  if (prevProps.onRender !== nextProps.onRender) {
    return false;
  }
  if (prevProps.fileTree !== nextProps.fileTree) {
    return false;
  }
  if (prevProps.loadingFiles !== nextProps.loadingFiles) {
    return false;
  }
  // Include lazy loading props in comparison
  if (prevProps.loadingPaths !== nextProps.loadingPaths) {
    return false;
  }
  if (prevProps.onLoadChildren !== nextProps.onLoadChildren) {
    return false;
  }
  if (prevProps.cancelChildLoading !== nextProps.cancelChildLoading) {
    return false;
  }
  // Include recursive selection props in comparison
  if (prevProps.onSelectFolderRecursively !== nextProps.onSelectFolderRecursively) {
    return false;
  }
  if (prevProps.isLoadingForSelection !== nextProps.isLoadingForSelection) {
    return false;
  }
  if (prevProps.loadingPathForSelection !== nextProps.loadingPathForSelection) {
    return false;
  }
  return true;
});

export default OptimizedFileTreeMemoized;
