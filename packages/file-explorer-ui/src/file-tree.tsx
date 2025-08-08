import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeRow, { ROW_HEIGHT } from './file-tree-row';
import { useVirtualList } from './use-virtual-list';
import { getVisibleNodes } from './utils/flatten-visible-nodes';

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

  const visibleNodes = useMemo(
    () => getVisibleNodes(fileTree, expandedDirectoryPaths),
    [fileTree, expandedDirectoryPaths]
  );

  const { containerRef, range, totalHeight } = useVirtualList(visibleNodes.length, ROW_HEIGHT, {
    overscan: 3,
  });

  const renderedRows = useMemo(() => {
    const startIndex = range.start;
    const endIndex = range.end;
    return visibleNodes
      .slice(startIndex, endIndex + 1)
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
          style={{ position: 'absolute', top: index * ROW_HEIGHT }}
        />
      ));
  }, [
    visibleNodes,
    range.start,
    range.end,
    expandedDirectoryPaths,
    toggleDirectoryExpansion,
    handleToggleFileSelection,
    loadingFiles,
    folderId,
  ]);

  // This effect will run if the onRender callback itself changes.
  useEffect(() => {
    onRender?.();
  }, [onRender]);

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
        style={{ height: totalHeight }}
      >
        {renderedRows}
      </div>
    </div>
  );
});

FileTree.displayName = 'FileTree';

export default FileTree;
