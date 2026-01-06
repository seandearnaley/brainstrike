import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeRow, { ROW_HEIGHT } from './file-tree-row';
import { useTreePerfMetrics } from './hooks/use-tree-perf-metrics';
import { useVirtualList } from './use-virtual-list';

type IFileTreeProps = {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
  /** Paths currently loading (for streaming cancellation) */
  loadingPaths?: Set<string>;
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: (path: string) => void;
};

/**
 * @file FileTree.tsx
 * @description Renders the file and folder structure.
 * @param {IFileNode[]} fileTree - The array of IFileNode objects representing the file structure to render.
 * @param {Set<string>} loadingFiles - A set of paths for files that are currently in a loading state.
 * @param {(() => void) | undefined} onRender - An optional callback function that is triggered when the tree component renders (primarily for testing).
 * @param {string} folderId - The identifier for the current folder context, used for selection and expansion state.
 *
 * Performance instrumentation (BST-145):
 * - flattenTree timing measured against FLATTEN_TREE budget (50ms)
 * - Enable metrics with VITE_DEV_PERF_METRICS=true in dev mode
 */
// Hoisted selectors to avoid recreating lambdas per render and keep dependency arity constant
const selectExpandedDirectoryPaths = (s: FileExplorerState) => s.expandedDirectoryPaths;
const selectSelectedFilePaths = (s: FileExplorerState) => s.selectedFilePaths;
const selectToggleDirectoryExpansion = (s: FileExplorerState) => s.toggleDirectoryExpansion;
const selectAddSelectedFile = (s: FileExplorerState) => s.addSelectedFile;
const selectRemoveSelectedFile = (s: FileExplorerState) => s.removeSelectedFile;

const FileTree = memo<IFileTreeProps>(
  ({ fileTree, loadingFiles, onRender, folderId, loadingPaths, cancelChildLoading }) => {
    const store = useFileExplorerStoreContext();
    const expandedDirectoryPaths = store(selectExpandedDirectoryPaths);
    const selectedFilePaths = store(selectSelectedFilePaths);
    const toggleDirectoryExpansion = store(selectToggleDirectoryExpansion);
    const addSelectedFile = store(selectAddSelectedFile);
    const removeSelectedFile = store(selectRemoveSelectedFile);

    // BST-145: Performance metrics (dev-only when VITE_DEV_PERF_METRICS=true)
    const { measureFlatten } = useTreePerfMetrics();

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

    const handleToggleFileSelection = useCallback(
      (path: string) => {
        const encodedPath = encodeFileSelection(folderId, path);
        const isSelected = selectedFilePaths.has(encodedPath);
        if (isSelected) {
          removeSelectedFile(folderId, path);
        } else {
          addSelectedFile(folderId, path);
        }
      },
      [folderId, addSelectedFile, removeSelectedFile, selectedFilePaths]
    );

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

    // BST-145: Measure flatten operation against FLATTEN_TREE budget
    const visibleNodes = useMemo(
      () => measureFlatten('FileTree.flattenTree', fileTree.length, () => flattenTree(fileTree)),
      [fileTree, flattenTree, measureFlatten]
    );

    const { containerRef, range, totalHeight } = useVirtualList(visibleNodes.length, ROW_HEIGHT, {
      overscan: 3,
    });

    const renderedRows = useMemo(
      () =>
        visibleNodes
          .slice(range.start, range.end + 1)
          .map(({ node, depth }, index) => (
            <FileTreeRow
              depth={depth}
              folderId={folderId}
              isExpanded={expandedDirectoryPaths.has(node.path) && node.loadState === 'loaded'}
              isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
              key={node.path}
              node={node}
              onToggleDirectoryExpansion={handleToggleDirectoryExpansion}
              onToggleFileSelection={handleToggleFileSelection}
              style={{ position: 'absolute', top: (range.start + index) * ROW_HEIGHT }}
            />
          )),
      [
        visibleNodes,
        range,
        expandedDirectoryPaths,
        handleToggleDirectoryExpansion,
        handleToggleFileSelection,
        loadingFiles,
        folderId,
      ]
    );

    // This effect will run if the onRender callback itself changes.
    useEffect(() => {
      onRender?.();
    }, [onRender]);

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

FileTree.displayName = 'FileTree';

export default FileTree;
