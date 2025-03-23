'use client';

import ErrorBoundary from '@/components/custom/error-boundary';
import { useFileExplorer } from '@/hooks/use-file-explorer';
import { useFileLoadingManager } from '@/hooks/use-file-loading-manager';
import { useQuickFilter } from '@/hooks/use-quick-filter';
import { useReportGeneration } from '@/hooks/use-report-generation';
import { useReportManager } from '@/hooks/use-report-manager';
import { useSelectionManager } from '@/hooks/use-selection-manager';
import { useToastManager } from '@/hooks/use-toast-manager';
import type { IFileNode } from '@/lib/file/types';
import { cn } from '@/lib/utils';
import { useFileExplorerStore } from '@/stores/use-file-explorer-store';
import { useCallback, useEffect, useState } from 'react';
import ActionButtons from './action-buttons';
import { FileExplorerStrings } from './constants/file-explorer-constants';
import { FileExplorerHeader } from './file-explorer-header';
import { FileExplorerMainPanel } from './file-explorer-main-panel';
import { FileExplorerSidebar } from './file-explorer-sidebar';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { LoadingOverlay } from './loading-overlay';

const FileExplorer: React.FC = () => {
  const {
    includeFilters,
    excludeFilters,
    useRegex,
    maxSelectionCount,
    includeProjectTree,
    folderSummaryThreshold,
    setFilters,
    currentFolderId,
    setCurrentFolderId,
  } = useFileExplorerStore();

  // Local state for UI
  const [displayedFiles, setDisplayedFiles] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const {
    fileTree,
    handleRootDirectorySelect,
    error: treeError,
    fileContents,
    applyFileFilters,
    filterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    refreshFileExplorer,
    isLoading,
    isInitialLoad,
    loadFileContent,
    loadingProgress,
  } = useFileExplorer({
    onDisplayedFilePathsChange: setDisplayedFiles,
  });

  const {
    toast,
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    handleSelectionLimitError,
  } = useToastManager();

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitError,
  });

  const {
    quickFilter,
    setQuickFilter,
    filteredTree: quickFilteredTree,
    clearFilter,
  } = useQuickFilter(fileTree);

  const { loadingFiles } = useFileLoadingManager({
    selectedFilePaths,
    fileContents,
    loadFileContent,
  });

  const { generateReportWithContent } = useReportGeneration({
    selectedFiles: selectedFilePaths,
    fileContents,
    rootDirectoryHandle: rootDirectoryHandle ?? undefined,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    folderSummaryThreshold,
  });

  const { handleDownloadReport, handleCopyReport } = useReportManager({
    rootDirectoryHandle,
    generateReportWithContent,
    showToast,
    toast,
  });

  useEffect(() => {
    if (quickFilteredTree) {
      const allVisibleFiles = new Set<string>();
      const collectVisibleFiles = (nodes: IFileNode[]) => {
        for (const node of nodes) {
          if (node.type === 'file' && node.isVisible !== false) {
            allVisibleFiles.add(node.path);
          } else if (node.type === 'directory' && node.children) {
            collectVisibleFiles(node.children);
          }
        }
      };
      collectVisibleFiles(quickFilteredTree);
      setDisplayedFiles(allVisibleFiles);
    }
  }, [quickFilteredTree]);

  const handleRefresh = useCallback(async () => {
    if (!rootDirectoryHandle) return;

    setIsRefreshing(true);
    try {
      await refreshFileExplorer();
      showToast({
        title: FileExplorerStrings.SUCCESS.TITLE,
        description: FileExplorerStrings.SUCCESS.REFRESH_SUCCESS,
      });
    } catch (error) {
      handleRefreshError(error);
    } finally {
      setIsRefreshing(false);
    }
  }, [rootDirectoryHandle, refreshFileExplorer, showToast, handleRefreshError]);

  const handleDirectorySelect = useCallback(async () => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      handleBrowserCompatibilityError(reason);
      return;
    }

    try {
      const handle = await handleRootDirectorySelect();
      if (handle === null) {
        // User cancelled the directory selection, do nothing
        return;
      }
      // Additional business logic for successful selection can be added here if needed
    } catch (error) {
      handleDirectorySelectError(error);
    }
  }, [
    handleRootDirectorySelect,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    isFileSystemAccessSupported,
  ]);

  const handleFilterChange = useCallback(
    (newIncludeFilters: string[], newExcludeFilters: string[], newUseRegex: boolean) => {
      setFilters(newIncludeFilters, newExcludeFilters);
      applyFileFilters(newIncludeFilters, newExcludeFilters, newUseRegex);
    },
    [setFilters, applyFileFilters]
  );

  const handleTreeRender = useCallback(() => {
    // This callback is called when the tree is rendered
    // You can use this to trigger any necessary updates
  }, []);

  useEffect(() => {
    if (rootDirectoryHandle) {
      setCurrentFolderId(rootDirectoryHandle.name);
    } else {
      setCurrentFolderId(null);
    }
  }, [rootDirectoryHandle, setCurrentFolderId]);

  const expandAll = useCallback(() => {
    if (fileTree && fileTree.length > 0) {
      useFileExplorerStore.getState().expandAllDirectories(fileTree);
    }
  }, [fileTree]);

  const collapseAll = useCallback(() => {
    useFileExplorerStore.getState().collapseAllDirectories();
  }, []);

  return (
    <ErrorBoundary>
      <div className="relative flex h-full flex-col">
        <LoadingOverlay
          isLoading={isLoading}
          isInitialLoad={isInitialLoad}
          progressState={
            loadingProgress ?? {
              loaded: 0,
              total: 0,
              phase: 'counting',
            }
          }
          className="z-50"
        />
        <FileExplorerHeader />
        <div
          className={cn('flex-1 flex flex-col overflow-hidden', {
            'pointer-events-none': isLoading,
          })}
        >
          <div className="flex flex-1 overflow-hidden">
            <div className="w-1/2 flex flex-col overflow-hidden px-2">
              <FileExplorerToolbar
                onDirectorySelect={handleDirectorySelect}
                onRefresh={handleRefresh}
                onFilterChange={handleFilterChange}
                filterError={filterError}
                maxSelectionCount={maxSelectionCount}
                quickFilter={quickFilter}
                setQuickFilter={setQuickFilter}
                clearQuickFilter={clearFilter}
                isLoading={isLoading}
                isRefreshing={isRefreshing}
                rootDirectoryHandle={rootDirectoryHandle}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
              />
              <FileExplorerSidebar
                rootDirectoryHandle={rootDirectoryHandle}
                treeError={treeError}
                filterError={filterError}
                includeFilters={includeFilters}
                excludeFilters={excludeFilters}
                useRegex={useRegex}
                quickFilter={quickFilter}
                quickFilteredTree={quickFilteredTree}
                loadingFiles={loadingFiles}
                isLoading={isLoading}
                isInitialLoad={isInitialLoad}
                currentFolderId={currentFolderId}
                onTreeRender={handleTreeRender}
              />
            </div>
            <div className="w-1/2 overflow-hidden pl-2">
              <FileExplorerMainPanel
                rootDirectoryHandle={rootDirectoryHandle}
                selectedFiles={selectedFilePaths}
                fileContents={fileContents}
                loadingFiles={loadingFiles}
                onSelectionChange={handleSelectionChange}
              />
            </div>
          </div>
          <footer className="mt-4">
            <ActionButtons
              displayedFiles={displayedFiles}
              onDownloadReport={handleDownloadReport}
              onCopyReport={handleCopyReport}
            />
          </footer>
        </div>
      </div>
    </ErrorBoundary>
  );
};

export default FileExplorer;
