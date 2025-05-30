import type { IFileNode } from '@brainstrike/types';
import {
  Checkbox,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { fileExplorer, isPathSelectedInFolder } from '@brainstrike/utils';
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2 as Link2Icon,
  Loader2,
  MoreHorizontal as MoreHorizontalIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';

interface FileTreeRowProps {
  node: IFileNode;
  depth: number;
  isExpanded: boolean;
  onToggleDirectoryExpansion: (path: string) => void;
  onToggleFileSelection: (path: string) => void;
  isLoading: boolean;
  folderId: string;
  style?: CSSProperties;
}

const ROW_HEIGHT = 28;

const FileTreeRow = memo<FileTreeRowProps>(
  ({
    node,
    depth,
    isExpanded,
    onToggleDirectoryExpansion,
    onToggleFileSelection,
    isLoading,
    folderId,
    style,
  }) => {
    const store = useFileExplorerStoreContext();
    const { selectedFilePaths, maxSelectionCount } = store();

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

    const handleNodeSelection = useCallback(() => {
      if (node.type !== 'directory') {
        onToggleFileSelection(node.path);
        return;
      }
      const allFilePaths = getAllFilePaths(node);
      if (allFilePaths.length === 0) return;
      const selectedCount = allFilePaths.filter((path) =>
        folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, path) : false
      ).length;
      const isFullySelected = selectedCount === allFilePaths.length;
      if (!isFullySelected) {
        const unselectedPaths = allFilePaths.filter(
          (path) => !(folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, path) : false)
        );
        const availableSlots = maxSelectionCount - selectedFilePaths.size;
        const pathsToSelect = unselectedPaths.slice(0, availableSlots);
        for (const path of pathsToSelect) {
          onToggleFileSelection(path);
        }
      } else {
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

    const handleExpansionClick = useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onToggleDirectoryExpansion(node.path);
      },
      [node.path, onToggleDirectoryExpansion]
    );

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

    const checkboxState = useMemo(() => {
      if (node.type === 'file') {
        return folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, node.path) : false;
      }
      const allFilePaths = getAllFilePaths(node);
      if (allFilePaths.length === 0) {
        return false;
      }
      const selectedCount = allFilePaths.filter((path) =>
        folderId ? isPathSelectedInFolder(selectedFilePaths, folderId, path) : false
      ).length;
      if (selectedCount === 0) {
        return false;
      }
      return selectedCount === allFilePaths.length ? true : 'indeterminate';
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);

    const folderInfo = useMemo(() => {
      if (node.type !== 'directory') return null;
      const { count, isComplete } = fileExplorer.getFolderFileCount(node);
      const selectedCount = getAllFilePaths(node).filter(
        (path) => folderId && isPathSelectedInFolder(selectedFilePaths, folderId, path)
      ).length;
      return { count, isComplete, selectedCount };
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);

    const wouldExceedLimit = useMemo(() => {
      if (node.type === 'file') {
        return (
          !(folderId && isPathSelectedInFolder(selectedFilePaths, folderId, node.path)) &&
          selectedFilePaths.size >= maxSelectionCount
        );
      }
      if (!folderInfo) return false;
      const unselectedCount = folderInfo.count - folderInfo.selectedCount;
      return selectedFilePaths.size + unselectedCount > maxSelectionCount;
    }, [node, selectedFilePaths, maxSelectionCount, folderInfo, folderId]);

    return (
      <li
        className="list-none flex items-center p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
        style={{ paddingLeft: depth * 24, height: ROW_HEIGHT, ...style }}
      >
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
        {node.isSymbolicLink && <Link2Icon className="mx-1 h-4 w-4 text-blue-500" />}
        <span className="ml-1">{node.name}</span>
        {node.type === 'directory' && node.isDepthTruncated && (
          <MoreHorizontalIcon className="ml-1 h-4 w-4 text-gray-500" />
        )}
      </li>
    );
  }
);

FileTreeRow.displayName = 'FileTreeRow';
export { ROW_HEIGHT };
export default FileTreeRow;
