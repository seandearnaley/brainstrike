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
  ({ fileTree, loadingFiles, onRender, folderId }) => {
    const store = useFileExplorerStoreContext();
    const expandedDirectoryPaths = store((s) => s.expandedDirectoryPaths);
    const toggleDirectoryExpansion = store((s) => s.toggleDirectoryExpansion);
    const toggleSelectedFile = store((s) => s.toggleSelectedFile);

    // Immediate file selection for better responsiveness
    const handleToggleFileSelection = useCallback(
      (path: string) => {
        if (!folderId) return;
        toggleSelectedFile(folderId, path);
      },
      [folderId, toggleSelectedFile]
    );

    // Optimized tree flattening with better memoization
    const flattenTree = useCallback(
      (nodes: IFileNode[], depth = 0, acc: { node: IFileNode; depth: number }[] = []) => {
        for (const n of nodes) {
          acc.push({ node: n, depth });
          if (n.type === 'directory' && expandedDirectoryPaths.has(n.path) && n.children) {
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
    const { containerRef, range, offset, totalHeight } = useVirtualList(
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
        if (!item) continue;

        const { node, depth } = item;
        const rowIndex = i - startIndex;

        rows.push(
          <OptimizedFileTreeRow
            key={node.path}
            node={node}
            depth={depth}
            isExpanded={expandedDirectoryPaths.has(node.path)}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            isLoading={
              folderId ? loadingFiles.has(encodeFileSelection(folderId, node.path)) : false
            }
            folderId={folderId}
            style={{
              position: 'absolute',
              top: (startIndex + rowIndex) * ROW_HEIGHT - offset,
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
      toggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
      offset,
    ]);

    // This effect will run if the onRender callback itself changes.
    useEffect(() => {
      onRender?.();
    }, [onRender]);

    // No cleanup needed anymore

    return (
      <div
        ref={containerRef}
        className="h-full relative flex-1 min-h-0 overflow-y-auto"
        data-testid="file-tree-scroll-container"
      >
        <div
          className="relative file-tree"
          role="tree"
          aria-label="File tree"
          data-testid="file-tree"
          style={{
            height: totalHeight,
            transform: `translateY(${offset}px)`,
            // Optimize for performance
            willChange: 'transform',
            contain: 'layout style paint',
          }}
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
  if (prevProps.folderId !== nextProps.folderId) return false;
  if (prevProps.onRender !== nextProps.onRender) return false;
  if (prevProps.fileTree !== nextProps.fileTree) return false;
  if (prevProps.loadingFiles !== nextProps.loadingFiles) return false;
  return true;
});

export default OptimizedFileTreeMemoized;
