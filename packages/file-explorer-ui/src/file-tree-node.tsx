import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { IFileNode } from '@brainstrike/types';
import { Checkbox } from '@brainstrike/ui';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { isPathSelectedInFolder } from '@brainstrike/utils';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { fileExplorer } from './lib/file/explorer';
import { FolderSelectionDialog } from './folder-selection-dialog';

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
    const { selectedFilePaths, expandedDirectoryPaths, maxSelectionCount } = useFileExplorerStore();
    const [showSelectionDialog, setShowSelectionDialog] = useState(false);

    /**
     * Gets all file paths in a directory node, including nested directories
     */
    const getAllFilePaths = useCallback((dirNode: IFileNode): string[] => {
      if (dirNode.type !== 'directory') return [];
      return (
        dirNode.children?.reduce((paths: string[], child: IFileNode) => {
          if (child.type === 'file') {
            paths.push(child.path);
          } else if (child.type === 'directory') {
            paths.push(...getAllFilePaths(child));
          }
          return paths;
        }, []) ?? []
      );
    }, []);

    /**
     * Handles checkbox selection for both files and directories.
     * For directories, shows a confirmation dialog if the folder contains many files.
     */
    const handleNodeSelection = useCallback(() => {
      if (node.type !== 'directory') {
        onToggleFileSelection(node.path);
        return;
      }

      // Get all file paths in the directory
      const allFilePaths = getAllFilePaths(node);
      if (allFilePaths.length === 0) return; // Don't process empty directories

      // For directories, check if we need to show the dialog
      const { count } = fileExplorer.getFolderFileCount(node);

      const selectedCount = allFilePaths.filter((path) =>
        isPathSelectedInFolder(selectedFilePaths, folderId, path)
      ).length;
      const isFullySelected = selectedCount === allFilePaths.length;

      // Only show the confirmation modal for large folders when no files are selected (i.e. on a select-all action)
      if (count > 10 && selectedCount === 0) {
        setShowSelectionDialog(true);
        return;
      }

      if (!isFullySelected) {
        // For folders that are not fully selected (including intermediate state), complete the selection by selecting all unselected files
        const unselectedPaths = allFilePaths.filter(
          (path) => !isPathSelectedInFolder(selectedFilePaths, folderId, path)
        );
        const availableSlots = maxSelectionCount - selectedFilePaths.size;
        const pathsToSelect = unselectedPaths.slice(0, availableSlots);
        for (const path of pathsToSelect) {
          onToggleFileSelection(path);
        }
      } else {
        // If fully selected, toggle to deselect all files
        for (const path of allFilePaths) {
          onToggleFileSelection(path);
        }
      }
    }, [
      node,
      selectedFilePaths,
      onToggleFileSelection,
      maxSelectionCount,
      getAllFilePaths,
      folderId,
    ]);

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
    const renderIcon = useCallback(() => {
      if (isLoading) {
        return (
          <Loader2
            size={16}
            className="text-blue-500 dark:text-blue-400 animate-spin"
            aria-label={`Loading ${node.name}`}
          />
        );
      }

      if (node.type === 'file') {
        return <FileIcon size={16} className="text-gray-500 dark:text-gray-400" />;
      }

      if (node.type === 'directory') {
        return isExpanded ? (
          <FolderOpen size={16} className="text-blue-500 dark:text-blue-400" />
        ) : (
          <Folder size={16} className="text-blue-500 dark:text-blue-400" />
        );
      }

      return null;
    }, [node.type, node.name, isExpanded, isLoading]);

    /**
     * Computes the checkbox state for the node.
     *
     * For files:
     * - Returns true if file is selected, false otherwise
     *
     * For directories:
     * - Returns true if all child files are selected
     * - Returns false if no child files are selected
     * - Returns 'indeterminate' if some (but not all) child files are selected
     */
    const checkboxState = useMemo(() => {
      if (node.type === 'file') {
        return isPathSelectedInFolder(selectedFilePaths, folderId, node.path);
      }

      const allFilePaths = getAllFilePaths(node);
      if (allFilePaths.length === 0) {
        return false;
      }

      const selectedCount = allFilePaths.filter((path) =>
        isPathSelectedInFolder(selectedFilePaths, folderId, path)
      ).length;
      if (selectedCount === 0) {
        return false;
      }

      return selectedCount === allFilePaths.length ? true : 'indeterminate';
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);

    /**
     * Calculate folder file count and selection status for tooltips
     */
    const folderInfo = useMemo(() => {
      if (node.type !== 'directory') return null;
      const { count, isComplete } = fileExplorer.getFolderFileCount(node);
      const selectedCount = getAllFilePaths(node).filter((path) =>
        isPathSelectedInFolder(selectedFilePaths, folderId, path)
      ).length;
      return { count, isComplete, selectedCount };
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);

    /**
     * Check if selecting this node would exceed the max selection limit
     */
    const wouldExceedLimit = useMemo(() => {
      if (node.type === 'file') {
        return (
          !isPathSelectedInFolder(selectedFilePaths, folderId, node.path) &&
          selectedFilePaths.size >= maxSelectionCount
        );
      }
      if (!folderInfo) return false;

      const unselectedCount = folderInfo.count - folderInfo.selectedCount;
      return selectedFilePaths.size + unselectedCount > maxSelectionCount;
    }, [node, selectedFilePaths, maxSelectionCount, folderInfo, folderId]);

    return (
      <li className="list-none">
        <div className="flex items-center p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center">
                  <Checkbox
                    id={node.path}
                    checked={checkboxState}
                    disabled={wouldExceedLimit}
                    className="mr-2"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!wouldExceedLimit) {
                        handleNodeSelection();
                      }
                    }}
                    aria-label={`Select ${node.name}`}
                  />
                </div>
              </TooltipTrigger>
              {wouldExceedLimit && (
                <TooltipContent>
                  <p>Cannot select more than {maxSelectionCount} files</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          {node.type === 'directory' && (
            <button
              type="button"
              onClick={handleExpansionClick}
              className="p-1 mr-1"
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
          {renderIcon()}
          <span className="ml-1">{node.name}</span>
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
