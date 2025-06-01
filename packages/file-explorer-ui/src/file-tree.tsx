import type { IFileNode } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileTreeRow from './file-tree-row';

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

  // Recursive function to render nodes
  const renderNodes = useCallback(
    (nodes: IFileNode[], depth = 0): React.ReactNode[] => {
      return nodes.map((node) => {
        const isExpanded = node.type === 'directory' && expandedDirectoryPaths.has(node.path);
        let childNodes: React.ReactNode = null;
        if (isExpanded && node.children) {
          const visibleChildren = node.children.filter((c) => c.isVisible !== false);
          if (visibleChildren.length > 0) {
            childNodes = renderNodes(visibleChildren, depth + 1);
          }
        }

        return (
          <FileTreeRow
            key={node.path}
            node={node}
            depth={depth}
            isExpanded={isExpanded}
            onToggleDirectoryExpansion={toggleDirectoryExpansion}
            onToggleFileSelection={handleToggleFileSelection}
            isLoading={loadingFiles.has(encodeFileSelection(folderId, node.path))}
            folderId={folderId}
          >
            {childNodes} {/* Pass rendered children to FileTreeRow */}
          </FileTreeRow>
        );
      });
    },
    [
      expandedDirectoryPaths,
      toggleDirectoryExpansion,
      handleToggleFileSelection,
      loadingFiles,
      folderId,
    ]
  );

  const renderedRows = useMemo(() => renderNodes(fileTree), [fileTree, renderNodes]);

  // This effect will run if the onRender callback itself changes.
  useEffect(() => {
    onRender?.();
  }, [onRender]);

  return (
    <div className="overflow-y-auto h-full relative file-tree-scroll flex-1 min-h-0">
      <ul className="relative file-tree" role="tree" aria-label="File tree">
        {renderedRows}
      </ul>
    </div>
  );
});

FileTree.displayName = 'FileTree';

export default FileTree;
