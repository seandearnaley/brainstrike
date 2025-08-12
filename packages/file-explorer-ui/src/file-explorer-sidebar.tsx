import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import type * as React from 'react';
// no additional React hooks needed here
import FileTree from './file-tree';
import OptimizedFileTree from './optimized-file-tree';

const NoFilesSelected = () => (
  <div className="text-center text-muted-foreground p-8">
    <p>No directory selected</p>
    <p className="text-sm mt-2">Use the folder button to select a directory</p>
  </div>
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
  // v2 feature flag (reserved for future lazy tree)
  useV2?: boolean;
}

const ErrorDisplay = ({
  treeError,
  filterError,
}: {
  treeError?: Error | null;
  filterError?: Error | null;
}) => (
  <div
    className="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 p-3 rounded m-2 text-sm"
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
  <div className="text-center text-muted-foreground py-8">
    {isLoading ? 'Loading files...' : 'No matching files found'}
    {/* biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for process.env */}
    {process.env['NODE_ENV'] === 'development' && (
      <div className="text-xs mt-2 opacity-50">
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
  useV2 = false,
}) => {
  const showError = (treeError || filterError) && !isLoading && !isInitialLoad;
  const hasContent = quickFilteredTree && quickFilteredTree.length > 0;
  // v2 path now manages expansion in zustand; local expandedPaths not needed here

  return (
    <div className="h-full min-h-0 w-full flex flex-col">
      {showError && <ErrorDisplay treeError={treeError} filterError={filterError} />}
      {!rootDirectoryHandle ? (
        <div className="flex-1 min-h-0">
          <NoFilesSelected />
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-3 pt-4 flex flex-col">
          {hasContent ? (
            useV2 ? (
              <OptimizedFileTree
                fileTree={quickFilteredTree}
                loadingFiles={loadingFiles}
                onRender={onTreeRender || undefined}
                folderId={currentFolderId || ''}
              />
            ) : (
              <FileTree
                fileTree={quickFilteredTree}
                loadingFiles={loadingFiles}
                onRender={onTreeRender || undefined}
                folderId={currentFolderId || ''}
              />
            )
          ) : (
            <EmptyState
              isLoading={isLoading}
              quickFilteredTree={quickFilteredTree}
              rootDirectoryHandle={rootDirectoryHandle}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default FileExplorerSidebar;
