import type { IFileNode } from '@brainstrike/types';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import {
  ChevronDown,
  ChevronRight,
  Link2 as Link2Icon,
  MoreHorizontal as MoreHorizontalIcon,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback } from 'react';
import { FolderSelectionDialog } from '../folder-selection-dialog';
import NodeCheckbox from '../node-checkbox';
import NodeIcon from '../node-icon';
import { useFileExplorerStoreSelector } from '../shell/file-explorer-provider';
import { useFileTreeNodeSelection } from './use-file-tree-node-selection';

interface IFileTreeNodeProps {
  folderId: string;
  isExpanded: boolean;
  isLoading: boolean;
  node: IFileNode;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
}

/**
 * FileTreeNode is a recursive component that renders a single node in the file explorer tree.
 * It handles both files and directories, with special behavior for directory selection.
 *
 * Key behaviors:
 * 1. Files can be individually selected/deselected
 * 2. Directories have a tri-state checkbox (selected/unselected/indeterminate)
 * 3. Directory selection cascades to all child files
 */
const FileTreeNode = memo<IFileTreeNodeProps>(
  ({
    node,
    isExpanded,
    onToggleDirectoryExpansion,
    onToggleFileSelection,
    isLoading,
    folderId,
  }) => {
    const selectedFilePaths = useFileExplorerStoreSelector((s) => s.selectedFilePaths);
    const expandedDirectoryPaths = useFileExplorerStoreSelector((s) => s.expandedDirectoryPaths);
    const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
    const {
      checkboxState,
      folderInfo,
      showSelectionDialog,
      setShowSelectionDialog,
      handleNodeSelection,
      wouldExceedLimit,
    } = useFileTreeNodeSelection({
      folderId,
      maxSelectionCount,
      node,
      onToggleFileSelection,
      selectedFilePaths,
    });

    /**
     * Handles directory expansion/collapse when clicking the chevron icon.
     * Prevents event propagation to avoid triggering selection.
     */
    const handleExpansionClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onToggleDirectoryExpansion(node.path);
      },
      [node.path, onToggleDirectoryExpansion]
    );

    return (
      <li className="list-none">
        <div className="flex items-center rounded p-1 transition-colors duration-150 hover:bg-accent">
          <NodeCheckbox
            checked={checkboxState}
            disabled={wouldExceedLimit}
            maxSelectionCount={maxSelectionCount}
            node={node}
            onSelect={handleNodeSelection}
            wouldExceedLimit={wouldExceedLimit}
          />
          <div className="flex w-6 items-center justify-center">
            {node.type === 'directory' && (
              <button
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
                className="cursor-pointer rounded-md p-1 transition-colors duration-150 hover:bg-accent"
                data-testid={EXPAND_COLLAPSE_TEST_ID}
                onClick={handleExpansionClick}
                type="button"
              >
                {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
            )}
          </div>
          <NodeIcon isExpanded={isExpanded} isLoading={isLoading} node={node} />
          {node.isSymbolicLink && <Link2Icon className="mx-1 h-4 w-4 text-blue-500" />}
          <span className="ml-1">{node.name}</span>
          {node.type === 'directory' && node.isDepthTruncated && (
            <MoreHorizontalIcon className="ml-1 h-4 w-4 text-gray-500" />
          )}
        </div>
        {node.type === 'directory' && isExpanded && node.children && (
          <fieldset aria-label={`Contents of ${node.name}`} className="ml-6">
            {node.children
              .filter((childNode: IFileNode) => childNode.isVisible !== false)
              .map((childNode: IFileNode) => (
                <FileTreeNode
                  folderId={folderId}
                  isExpanded={
                    expandedDirectoryPaths.has(childNode.path) && childNode.loadState === 'loaded'
                  }
                  isLoading={isLoading}
                  key={childNode.path}
                  node={childNode}
                  onToggleDirectoryExpansion={onToggleDirectoryExpansion}
                  onToggleFileSelection={onToggleFileSelection}
                />
              ))}
          </fieldset>
        )}
        <FolderSelectionDialog
          fileCount={folderInfo?.count ?? 0}
          node={node}
          onConfirm={handleNodeSelection}
          onOpenChange={setShowSelectionDialog}
          onToggleFileSelection={onToggleFileSelection}
          open={showSelectionDialog}
        />
      </li>
    );
  }
);

FileTreeNode.displayName = 'FileTreeNode';

export default FileTreeNode;
