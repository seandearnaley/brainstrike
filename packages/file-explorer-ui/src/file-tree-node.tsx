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
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { FolderSelectionDialog } from './folder-selection-dialog';
import NodeCheckbox from './node-checkbox';
import NodeIcon from './node-icon';
import { useFileTreeNodeSelection } from './use-file-tree-node-selection';

interface IFileTreeNodeProps {
  node: IFileNode;
  isExpanded: boolean;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
  isLoading: boolean;
  folderId: string;
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
    const store = useFileExplorerStoreContext();
    const { selectedFilePaths, expandedDirectoryPaths, maxSelectionCount } = store(
      (s) => ({
        selectedFilePaths: s.selectedFilePaths,
        expandedDirectoryPaths: s.expandedDirectoryPaths,
        maxSelectionCount: s.maxSelectionCount,
      }),
      shallow
    );
    const {
      checkboxState,
      folderInfo,
      showSelectionDialog,
      setShowSelectionDialog,
      handleNodeSelection,
      wouldExceedLimit,
    } = useFileTreeNodeSelection({
      node,
      folderId,
      selectedFilePaths,
      maxSelectionCount,
      onToggleFileSelection,
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

    /**
     * Determines the appropriate icon to display based on node type and state.
     * - Files: Show file icon
     * - Directories: Show folder/folder-open based on expansion state
     * - Loading state: Show spinner
     */
    const renderIcon = useCallback(
      () => <NodeIcon node={node} isExpanded={isExpanded} isLoading={isLoading} />,
      [node, isExpanded, isLoading]
    );

    return (
      <li className="list-none">
        <div className="flex items-center p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">
          <NodeCheckbox
            node={node}
            checked={checkboxState}
            disabled={wouldExceedLimit}
            onSelect={handleNodeSelection}
            wouldExceedLimit={wouldExceedLimit}
            maxSelectionCount={maxSelectionCount}
          />
          <div className="w-6 flex items-center justify-center">
            {node.type === 'directory' && (
              <button
                type="button"
                className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700"
                onClick={handleExpansionClick}
                data-testid={EXPAND_COLLAPSE_TEST_ID}
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
            )}
          </div>
          {renderIcon()}
          {node.isSymbolicLink && <Link2Icon className="mx-1 h-4 w-4 text-blue-500" />}
          <span className="ml-1">{node.name}</span>
          {node.type === 'directory' && node.isDepthTruncated && (
            <MoreHorizontalIcon className="ml-1 h-4 w-4 text-gray-500" />
          )}
        </div>
        {node.type === 'directory' && isExpanded && node.children && (
          <fieldset className="ml-6" aria-label={`Contents of ${node.name}`}>
            {node.children
              .filter((childNode: IFileNode) => childNode.isVisible !== false)
              .map((childNode: IFileNode) => (
                <FileTreeNode
                  key={childNode.path}
                  node={childNode}
                  isExpanded={expandedDirectoryPaths.has(childNode.path)}
                  onToggleDirectoryExpansion={onToggleDirectoryExpansion}
                  onToggleFileSelection={onToggleFileSelection}
                  isLoading={isLoading}
                  folderId={folderId}
                />
              ))}
          </fieldset>
        )}
        <FolderSelectionDialog
          open={showSelectionDialog}
          onOpenChange={setShowSelectionDialog}
          node={node}
          fileCount={folderInfo?.count ?? 0}
          onConfirm={handleNodeSelection}
          onToggleFileSelection={onToggleFileSelection}
        />
      </li>
    );
  }
);

FileTreeNode.displayName = 'FileTreeNode';

export default FileTreeNode;
