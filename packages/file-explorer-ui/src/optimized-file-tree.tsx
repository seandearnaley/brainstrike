import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileContentPriority } from './file-content-context';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import OptimizedFileTreeRow, { ROW_HEIGHT } from './optimized-file-tree-row';
import { useFileExplorer } from './use-file-explorer-context';
import { useVirtualList } from './use-virtual-list';
import { getVisibleNodes } from './utils/flatten-visible-nodes';

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
    const priorityQueueRef = useFileContentPriority();
    const store = useFileExplorerStoreContext();
    const { loadChildren } = useFileExplorer();
    const {
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      addSelectedFile,
      removeSelectedFile,
      _expandedVersion,
    } = store(
      (s) => ({
        expandedDirectoryPaths: s.expandedDirectoryPaths,
        toggleDirectoryExpansion: s.toggleDirectoryExpansion,
        addSelectedFile: s.addSelectedFile,
        removeSelectedFile: s.removeSelectedFile,
        _expandedVersion: s._expandedVersion,
      }),
      shallow
    );

    // Immediate file selection for better responsiveness
    const handleToggleFileSelection = useCallback(
      (path: string) => {
        const encodedPath = encodeFileSelection(folderId, path);
        const isSelected = store.getState().selectedFilePaths.has(encodedPath);
        if (isSelected) {
          removeSelectedFile(folderId, path);
        } else {
          addSelectedFile(folderId, path);
        }
      },
      [folderId, addSelectedFile, removeSelectedFile, store]
    );

    // Cached visible nodes calculation keyed by tree identity and expanded set
    const visibleNodes = useMemo(
      () => getVisibleNodes(fileTree, expandedDirectoryPaths, _expandedVersion),
      [fileTree, expandedDirectoryPaths, _expandedVersion]
    );

    // Enhanced virtualization with improved performance
    const overscan = visibleNodes.length > 5000 ? 1 : 2;
    const { containerRef, range, totalHeight } = useVirtualList(visibleNodes.length, ROW_HEIGHT, {
      overscan,
    });

    // Optimized row rendering with better memoization
    const handleToggleDirectoryExpansion = useCallback(
      async (path: string) => {
        const isExpanding = !expandedDirectoryPaths.has(path);
        if (isExpanding) {
          const node = visibleNodes.find((v) => v.node.path === path)?.node;
          if (node && node.type === 'directory' && node.isDepthTruncated) {
            await loadChildren(path);
          }
        }
        toggleDirectoryExpansion(path);
      },
      [expandedDirectoryPaths, visibleNodes, loadChildren, toggleDirectoryExpansion]
    );

    const renderedRows = useMemo(() => {
      const startIndex = range.start;
      const endIndex = range.end;
      const rows = [];

      for (let i = startIndex; i <= endIndex; i++) {
        const item = visibleNodes[i];
        if (!item) continue;

        const { node, depth } = item;
        const rowIndex = i - startIndex;

        if (node.type === 'file') {
          const key = encodeFileSelection(folderId, node.path);
          const existing = priorityQueueRef.current.filter((k) => k !== key);
          priorityQueueRef.current = [key, ...existing];
        }

        rows.push(
          <OptimizedFileTreeRow
            key={node.path}
            node={node}
            depth={depth}
            isExpanded={expandedDirectoryPaths.has(node.path)}
            onToggleDirectoryExpansion={handleToggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
            folderId={folderId}
            style={{
              position: 'absolute',
              top: (startIndex + rowIndex) * ROW_HEIGHT,
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
      priorityQueueRef,
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

// Enhanced memoization comparison
const OptimizedFileTreeMemoized = memo(OptimizedFileTree, (prevProps, nextProps) => {
  // Only re-render if essential props changed
  if (prevProps.folderId !== nextProps.folderId) return false;
  if (prevProps.onRender !== nextProps.onRender) return false;

  // Deep comparison for fileTree (expensive but necessary)
  if (prevProps.fileTree.length !== nextProps.fileTree.length) return false;

  // Check if fileTree structure actually changed
  for (let i = 0; i < prevProps.fileTree.length; i++) {
    const prevNode = prevProps.fileTree[i];
    const nextNode = nextProps.fileTree[i];

    if (prevNode?.path !== nextNode?.path) return false;
    if (prevNode?.type !== nextNode?.type) return false;
    if (prevNode?.isVisible !== nextNode?.isVisible) return false;
  }

  // Check loading files set
  if (prevProps.loadingFiles.size !== nextProps.loadingFiles.size) return false;

  // Quick set comparison for loading files
  for (const file of prevProps.loadingFiles) {
    if (!nextProps.loadingFiles.has(file)) return false;
  }

  return true; // Props are equal, skip re-render
});

export default OptimizedFileTreeMemoized;
