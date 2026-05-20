import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { EmptyState } from '@brainstrike/ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import { memo, useDeferredValue } from 'react';
import OptimizedFileTree from './tree/optimized-file-tree';
import { getRootFolderId } from './utils/get-root-folder-id';

const NoFilesSelected = () => (
  <EmptyState
    description="Connect a directory to browse your project and select files"
    icon={<FolderOpen />}
    title="No directory selected"
  />
);

/**
 * Loading indicator shown during Select All operations.
 * Uses a subtle overlay with spinner to indicate work in progress
 * without being too intrusive.
 */
const SelectAllLoadingIndicator = () => (
  <div
    className="absolute inset-0 z-30 flex items-center justify-center bg-background/50"
    data-testid="select-all-loading-overlay"
  >
    <div className="flex items-center gap-2 rounded-md bg-background/90 px-3 py-2 shadow-sm">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span className="text-muted-foreground text-xs">Selecting files...</span>
    </div>
  </div>
);

interface FileExplorerSidebarProps {
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: (path: string) => void;
  currentFolderId: string | null;
  filterError: Error | null;
  isInitialLoad: boolean;
  isLoading: boolean;
  /** Whether the entire tree is being loaded for select all */
  isLoadingForSelectAll?: boolean;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean;
  loadingFiles: Set<string>;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string>;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: (path: string) => Promise<void>;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?: (
    node: IFileNode
  ) => Promise<{ success: boolean; filePaths: string[] }>;
  onTreeRender?: () => void;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
  treeError: Error | null;
}

const ErrorDisplay = ({
  treeError,
  filterError,
}: {
  treeError?: Error | null;
  filterError?: Error | null;
}) => (
  <div
    className="m-2 rounded border border-red-400 bg-red-100 p-3 text-red-700 text-sm dark:border-red-700 dark:bg-red-900 dark:text-red-200"
    role="alert"
  >
    <strong>Error: </strong>
    {treeError?.message}
    {filterError && ` ${filterError.message}`}
  </div>
);

const EmptyStateComponent = ({
  isLoading,
}: {
  isLoading: boolean;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
}) => (
  <div className="py-8 text-center text-muted-foreground">
    {isLoading ? 'Loading files...' : 'No matching files found'}
  </div>
);

const FileExplorerSidebar: React.FC<FileExplorerSidebarProps> = memo(
  ({
    rootDirectoryHandle,
    treeError,
    filterError,
    quickFilteredTree,
    loadingFiles,
    isLoading,
    isInitialLoad,
    currentFolderId,
    onTreeRender,
    loadingPaths,
    onLoadChildren,
    cancelChildLoading,
    onSelectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    isLoadingForSelectAll = false,
  }) => {
    // React 19: useDeferredValue keeps showing the old tree while new one renders
    // This prevents "flash" during rapid tree updates (like expand-all)
    const deferredTree = useDeferredValue(quickFilteredTree);

    const showError = (treeError || filterError) && !isLoading && !isInitialLoad;
    const hasContent = deferredTree && deferredTree.length > 0;

    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
        {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
        {rootDirectoryHandle ? (
          <div className="relative flex min-h-0 flex-1 flex-col pt-10">
            {/* Subtle loading overlay during Select All operation */}
            {isLoadingForSelectAll && <SelectAllLoadingIndicator />}
            {hasContent ? (
              <OptimizedFileTree
                cancelChildLoading={cancelChildLoading}
                fileTree={deferredTree}
                folderId={getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? ''}
                isLoadingForSelection={isLoadingForSelection}
                loadingFiles={loadingFiles}
                loadingPathForSelection={loadingPathForSelection}
                loadingPaths={loadingPaths}
                onLoadChildren={onLoadChildren}
                onRender={onTreeRender || undefined}
                onSelectFolderRecursively={onSelectFolderRecursively}
              />
            ) : (
              <EmptyStateComponent
                isLoading={isLoading}
                quickFilteredTree={deferredTree}
                rootDirectoryHandle={rootDirectoryHandle}
              />
            )}
          </div>
        ) : (
          <div className="flex-1">
            <NoFilesSelected />
          </div>
        )}
      </div>
    );
  }
);

export default FileExplorerSidebar;
