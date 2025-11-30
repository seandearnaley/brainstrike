import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import type * as React from 'react';
import OptimizedFileTree from './optimized-file-tree';

const NoFilesSelected = () => (
  <div className="p-8 text-center text-muted-foreground">
    <p>No directory selected</p>
    <p className="mt-2 text-sm">Use the folder button to select a directory</p>
  </div>
);

type FileExplorerSidebarProps = {
  rootDirectoryHandle: DirectoryHandle | null;
  treeError: Error | null;
  filterError: Error | null;
  quickFilteredTree: IFileNode[] | null;
  loadingFiles: Set<string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  currentFolderId: string | null;
  onTreeRender?: () => void;
};

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

const EmptyState = ({
  isLoading,
  quickFilteredTree,
  rootDirectoryHandle,
}: {
  isLoading: boolean;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
}) => (
  <div className="py-8 text-center text-muted-foreground">
    {isLoading ? 'Loading files...' : 'No matching files found'}
    {process.env['NODE_ENV'] === 'development' && (
      <div className="mt-2 text-xs opacity-50">
        Debug: quickFilteredTree={quickFilteredTree ? quickFilteredTree.length : 'null'}, isLoading=
        {String(isLoading)}, rootHandle={rootDirectoryHandle ? 'present' : 'null'}
      </div>
    )}
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
}) => {
  const showError = (treeError || filterError) && !isLoading && !isInitialLoad;
  const hasContent = quickFilteredTree && quickFilteredTree.length > 0;

  return (
    <div className="w-full">
      {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
      {rootDirectoryHandle ? (
        <div className="px-3 pt-4">
          {hasContent ? (
            <OptimizedFileTree
              fileTree={quickFilteredTree}
              folderId={(rootDirectoryHandle?.name ?? currentFolderId ?? '') as string}
              loadingFiles={loadingFiles}
              onRender={onTreeRender || undefined}
            />
          ) : (
            <EmptyState
              isLoading={isLoading}
              quickFilteredTree={quickFilteredTree}
              rootDirectoryHandle={rootDirectoryHandle}
            />
          )}
        </div>
      ) : (
        <NoFilesSelected />
      )}
    </div>
  );
};

export default FileExplorerSidebar;
