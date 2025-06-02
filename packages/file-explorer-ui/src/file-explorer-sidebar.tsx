import type { IFileNode } from '@brainstrike/types';
import type * as React from 'react';
import FileTree from './file-tree';

const NoFilesSelected = () => (
  <div className="text-center text-muted-foreground p-8">
    <p>No directory selected</p>
    <p className="text-sm mt-2">Use the folder button to select a directory</p>
  </div>
);

interface FileExplorerSidebarProps {
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
  treeError: Error | null;
  filterError: Error | null;
  quickFilteredTree: IFileNode[] | null;
  loadingFiles: Set<string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  currentFolderId: string | null;
  onTreeRender?: () => void;
}

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
  return (
    <div className="w-full">
      {(treeError || filterError) && !isLoading && !isInitialLoad && (
        <div
          className="bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 p-3 rounded m-2 text-sm"
          role="alert"
        >
          <strong>Error: </strong>
          {treeError?.message}
          {filterError && ` ${filterError.message}`}
        </div>
      )}
      {!rootDirectoryHandle ? (
        <NoFilesSelected />
      ) : (
        <div className="px-2 pt-2">
          {quickFilteredTree && quickFilteredTree.length > 0 ? (
            <FileTree
              fileTree={quickFilteredTree}
              loadingFiles={loadingFiles}
              onRender={onTreeRender || undefined}
              folderId={currentFolderId || ''}
            />
          ) : (
            <div className="text-center text-muted-foreground py-8">No matching files found</div>
          )}
        </div>
      )}
    </div>
  );
};

export default FileExplorerSidebar;
