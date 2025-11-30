import type { FileExplorerState, IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeRow, { ROW_HEIGHT } from './file-tree-row';
import { useVirtualList } from './use-virtual-list';

type IFileTreeProps = {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
};

/**
 * @file FileTree.tsx
 * @description Renders the file and folder structure.
 * @param {IFileNode[]} fileTree - The array of IFileNode objects representing the file structure to render.
 * @param {Set<string>} loadingFiles - A set of paths for files that are currently in a loading state.
 * @param {(() => void) | undefined} onRender - An optional callback function that is triggered when the tree component renders (primarily for testing).
 * @param {string} folderId - The identifier for the current folder context, used for selection and expansion state.
 */
// Hoisted selectors to avoid recreating lambdas per render and keep dependency arity constant
const selectExpandedDirectoryPaths = (s: FileExplorerState) => s.expandedDirectoryPaths;
const selectSelectedFilePaths = (s: FileExplorerState) => s.selectedFilePaths;
const selectToggleDirectoryExpansion = (s: FileExplorerState) => s.toggleDirectoryExpansion;
const selectAddSelectedFile = (s: FileExplorerState) => s.addSelectedFile;
const selectRemoveSelectedFile = (s: FileExplorerState) => s.removeSelectedFile;

const FileTree = memo<IFileTreeProps>(({ fileTree, loadingFiles, onRender, folderId }) => {
  const store = useFileExplorerStoreContext();
  const expandedDirectoryPaths = store(selectExpandedDirectoryPaths);
  const selectedFilePaths = store(selectSelectedFilePaths);
  const toggleDirectoryExpansion = store(selectToggleDirectoryExpansion);
  const addSelectedFile = store(selectAddSelectedFile);
  const removeSelectedFile = store(selectRemoveSelectedFile);

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

  const visibleNodes = useMemo(() => flattenTree(fileTree), [fileTree, flattenTree]);

  const { containerRef, range, offset, totalHeight } = useVirtualList(
    visibleNodes.length,
    ROW_HEIGHT,
    { overscan: 3 }
  );

  const renderedRows = useMemo(
    () =>
      visibleNodes
        .slice(range.start, range.end + 1)
        .map(({ node, depth }, index) => (
          <FileTreeRow
            depth={depth}
            folderId={folderId}
            isExpanded={expandedDirectoryPaths.has(node.path)}
            isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
            key={node.path}
            node={node}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            style={{ position: 'absolute', top: (range.start + index) * ROW_HEIGHT - offset }}
          />
        )),
    [
      visibleNodes,
      range,
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
      offset,
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
        style={{ height: totalHeight, transform: `translateY(${offset}px)` }}
      >
        {renderedRows}
      </div>
    </div>
  );
});

FileTree.displayName = 'FileTree';

export default FileTree;
