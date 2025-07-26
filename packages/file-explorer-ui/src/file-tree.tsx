import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeRow, { ROW_HEIGHT } from './file-tree-row';
import { useVirtualList } from './use-virtual-list';

interface IFileTreeProps {
  fileTree: IFileNode[];
  loadingFiles: Set<string>;
  onRender?: (() => void) | undefined;
  folderId: string;
}

/**
 * @file FileTree.tsx
 * @description Renders the file and folder structure.
 * @param {IFileNode[]} fileTree - The array of IFileNode objects representing the file structure to render.
 * @param {Set<string>} loadingFiles - A set of paths for files that are currently in a loading state.
 * @param {(() => void) | undefined} onRender - An optional callback function that is triggered when the tree component renders (primarily for testing).
 * @param {string} folderId - The identifier for the current folder context, used for selection and expansion state.
 */
const FileTree = memo<IFileTreeProps>(({ fileTree, loadingFiles, onRender, folderId }) => {
  const store = useFileExplorerStoreContext();
  const {
    expandedDirectoryPaths,
    selectedFilePaths,
    toggleDirectoryExpansion,
    addSelectedFile,
    removeSelectedFile,
  } = store(
    (s) => ({
      expandedDirectoryPaths: s.expandedDirectoryPaths,
      selectedFilePaths: s.selectedFilePaths,
      toggleDirectoryExpansion: s.toggleDirectoryExpansion,
      addSelectedFile: s.addSelectedFile,
      removeSelectedFile: s.removeSelectedFile,
    }),
    shallow
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
            key={node.path}
            node={node}
            depth={depth}
            isExpanded={expandedDirectoryPaths.has(node.path)}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
            folderId={folderId}
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
    <div ref={containerRef} className="h-full relative flex-1 min-h-0">
      <div
        className="relative file-tree"
        role="tree"
        aria-label="File tree"
        data-testid="file-tree"
        style={{ height: totalHeight, transform: `translateY(${offset}px)` }}
      >
        {renderedRows}
      </div>
    </div>
  );
});

FileTree.displayName = 'FileTree';

export default FileTree;
