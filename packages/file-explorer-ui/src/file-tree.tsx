import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeNode from './file-tree-node';

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
  const { expandedDirectoryPaths, toggleDirectoryExpansion, addSelectedFile, removeSelectedFile } =
    store();

  // Use separate useEffect for onRender to avoid lint warnings
  useEffect(() => {
    onRender?.();
  }, [onRender]);

  // Trigger onRender when fileTree changes (for test purposes)
  // We intentionally include fileTree as a dependency for testing purposes
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileTree is needed for test re-renders
  useEffect(() => {
    onRender?.();
  }, [fileTree, onRender]);

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

  const renderFileTreeNode = useCallback(
    (node: IFileNode) => {
      return (
        <FileTreeNode
          key={node.path}
          node={node}
          isExpanded={expandedDirectoryPaths.has(node.path)}
          onToggleDirectoryExpansion={toggleDirectoryExpansion}
          onToggleFileSelection={handleToggleFileSelection}
          isLoading={loadingFiles.has(node.path)}
          folderId={folderId}
        />
      );
    },
    [
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
    ]
  );

  const renderedTree = useMemo(
    () => fileTree.map(renderFileTreeNode),
    [fileTree, renderFileTreeNode]
  );

  return (
    <ul className="file-tree" role="tree" aria-label="File tree">
      {renderedTree}
    </ul>
  );
});

FileTree.displayName = 'FileTree';

export default FileTree;
