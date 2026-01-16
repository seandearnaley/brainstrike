import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { EmptyState } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { useDeferredValue } from 'react';
import OptimizedFileTree from './optimized-file-tree';

const NoFilesSelected = () => (
  <EmptyState
    description="Connect a directory to browse your project and select files"
    icon={<FolderOpen />}
    title="No directory selected"
  />
);

interface FileExplorerSidebarProps {
  rootDirectoryHandle: DirectoryHandle | null;
  treeError: Error | null;
  filterError: Error | null;
  quickFilteredTree: IFileNode[] | null;
  loadingFiles: Set<string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  currentFolderId: string | null;
  onTreeRender?: () => void;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string>;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: (path: string) => Promise<void>;
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: (path: string) => void;
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

const FileExplorerSidebar: React.FC<FileExplorerSidebarProps> = ({
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
        <div className="flex min-h-0 flex-1 flex-col pt-2">
          {hasContent ? (
            <OptimizedFileTree
              cancelChildLoading={cancelChildLoading}
              fileTree={deferredTree}
              folderId={(rootDirectoryHandle?.name ?? currentFolderId ?? '') as string}
              loadingFiles={loadingFiles}
              loadingPaths={loadingPaths}
              onLoadChildren={onLoadChildren}
              onRender={onTreeRender || undefined}
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
};

export default FileExplorerSidebar;
