import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import {
  FileExplorerErrorBoundary,
  FileExplorerToolbar,
  LoadingOverlay,
} from '@brainstrike/file-explorer-ui';
import { useQuickFilter, useReportGeneration, useReportManager } from '@brainstrike/hooks';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import {
  Button,
  cn,
  LoadingFallback,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils';
import { ChevronsDown, ChevronsUp, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { DirectoryStatus, FilterStatus } from './file-explorer-status-components';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

// Lazy load the sidebar component
const FileExplorerSidebar = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.FileExplorerSidebar as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

// Lazy load action buttons
const ActionButtons = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.ActionButtons as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

function collectVisibleFiles(nodes: IFileNode[], fileSet: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'file' && node.isVisible !== false) {
      fileSet.add(node.path);
    } else if (node.type === 'directory' && node.children) {
      collectVisibleFiles(node.children, fileSet);
    }
  }
}

/**
 * FileExplorerLeftPanel - Contains the file tree and toolbar
 * This component can be used independently in the left panel of an IDE layout
 */
export const FileExplorerLeftPanel: React.FC = React.memo(() => {
  'use no memo';
  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  const {
    includeFilters,
    excludeFilters,
    useRegex,
    setFilters,
    currentFolderId,
    setCurrentFolderId,
    maxSelectionCount,
    includeProjectTree,
    folderSummaryThreshold,
  } = store(
    (s) => ({
      includeFilters: s.includeFilters,
      excludeFilters: s.excludeFilters,
      useRegex: s.useRegex,
      setFilters: s.setFilters,
      currentFolderId: s.currentFolderId,
      setCurrentFolderId: s.setCurrentFolderId,
      maxSelectionCount: s.maxSelectionCount,
      includeProjectTree: s.includeProjectTree,
      folderSummaryThreshold: s.folderSummaryThreshold,
    }),
    shallow
  );

  // Local state for UI
  const [isRefreshing, setIsRefreshing] = useState(false);

  const {
    fileTree,
    handleRootDirectorySelect,
    isLoading,
    error,
    fileContents,
    loadingFiles,
    applyFileFilters,
    filterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    refreshFileExplorer,
    isInitialLoad,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
  } = useFileExplorer();

  const onSelectionLimitExceeded = useCallback(() => {
    // Selection limit handling is managed by action buttons
  }, []);

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded,
  });

  const { generateReportWithContent } = useReportGeneration({
    selectedFiles: selectedFilePaths,
    fileContents,
    rootDirectoryHandle: rootDirectoryHandle ?? undefined,
    fileSystemAdapter,
    includeFilters,
    excludeFilters,
    useRegex,
    includeProjectTree,
    folderSummaryThreshold,
  });

  const {
    toast,
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
  } = useToastManager();

  const { handleDownloadReport, handleCopyReport } = useReportManager({
    rootDirectoryHandle,
    generateReportWithContent,
    showToast,
    toast,
  });

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) return null;
    return new Error(filterError);
  }, [filterError]);

  const stableFileTree = useMemo(() => fileTree || [], [fileTree]);

  const {
    quickFilter,
    setQuickFilter,
    clearFilter,
    filteredTree: quickFilteredTree,
  } = useQuickFilter(stableFileTree);

  // Calculate displayed files from the quick filtered tree
  const displayedFilesRef = React.useRef<Set<string>>(new Set());
  const displayedFiles = useMemo(() => {
    const visible = new Set<string>();
    if (quickFilteredTree) {
      collectVisibleFiles(quickFilteredTree, visible);
    }
    displayedFilesRef.current = visible;
    return visible;
  }, [quickFilteredTree]);

  const handleRefresh = useCallback(async () => {
    if (!rootDirectoryHandle) return;

    setIsRefreshing(true);
    try {
      await refreshFileExplorer();
      showToast({
        title: FileExplorerStrings.success.title,
        description: FileExplorerStrings.success.refreshSuccess,
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
      // Only set the folder ID if it's different from the current one
      // This prevents clearing selections when the same directory is already selected
      const currentState = store.getState();
      if (currentState.currentFolderId !== rootDirectoryHandle.name) {
        setCurrentFolderId(rootDirectoryHandle.name);
      }
    } else {
      setCurrentFolderId(null);
    }
  }, [rootDirectoryHandle, setCurrentFolderId, store]);

  const expandAll = useCallback(() => {
    if (fileTree && fileTree.length > 0) {
      store.getState().expandAllDirectories(fileTree);
    }
  }, [fileTree, store]);

  const collapseAll = useCallback(() => {
    store.getState().collapseAllDirectories();
  }, [store]);

  const handleCancelOperation = useCallback(() => {
    cancelOperation();
    showToast({
      title: 'Operation Cancelled',
      description: 'The file loading operation has been cancelled.',
      variant: 'default',
    });
  }, [cancelOperation, showToast]);

  return (
    <FileExplorerErrorBoundary>
      <div className="h-full grid grid-rows-[auto_1fr_auto]">
        <LoadingOverlay
          isLoading={isLoading}
          isInitialLoad={isInitialLoad}
          progressState={
            loadingProgress ?? {
              loaded: 0,
              total: 0,
              phase: 'counting' as const,
            }
          }
          cancellable={cancellable}
          onCancel={handleCancelOperation}
          isCancelling={isCancelling}
          className="z-50"
        />

        {/* Fixed Header */}
        <div className="shrink-0">
          <FileExplorerToolbar
            onDirectorySelect={handleDirectorySelect}
            onFilterChange={handleFilterChange}
            filterError={filterError}
            quickFilter={quickFilter}
            setQuickFilter={setQuickFilter}
            clearQuickFilter={clearFilter}
            isLoading={isLoading}
            rootDirectoryHandle={rootDirectoryHandle}
          />
          <DirectoryStatus rootDirectoryHandle={rootDirectoryHandle} />
          <FilterStatus
            includeFilters={includeFilters}
            excludeFilters={excludeFilters}
            useRegex={useRegex}
            quickFilter={quickFilter}
          />
        </div>

        {/* Scrollable Middle Content */}
        <div className="relative flex-1 min-h-0">
          {/* Fixed buttons overlay - outside scrollable area */}
          {rootDirectoryHandle && (
            <div className="absolute top-2 right-6 flex items-center gap-1 z-20">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                    data-testid="refresh-button-small"
                    onClick={handleRefresh}
                    disabled={isLoading || isRefreshing}
                    aria-label="Refresh"
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', { 'animate-spin': isRefreshing })} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Refresh file tree</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                    data-testid="expand-all-button-small"
                    onClick={expandAll}
                    disabled={isLoading || isRefreshing}
                    aria-label="Expand All"
                  >
                    <ChevronsDown className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Expand all directories</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                    data-testid="collapse-all-button-small"
                    onClick={collapseAll}
                    disabled={isLoading || isRefreshing}
                    aria-label="Collapse All"
                  >
                    <ChevronsUp className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Collapse all directories</p>
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Scrollable content */}
          <div className="overflow-y-auto h-full">
            <Suspense fallback={<LoadingFallback />}>
              <FileExplorerSidebar
                rootDirectoryHandle={rootDirectoryHandle}
                treeError={error}
                filterError={filterErrorAsError}
                quickFilteredTree={quickFilteredTree}
                loadingFiles={loadingFiles}
                isLoading={isLoading}
                isInitialLoad={isInitialLoad}
                currentFolderId={currentFolderId}
                onTreeRender={handleTreeRender}
              />
            </Suspense>
          </div>
        </div>

        {/* Fixed Footer */}
        <div className="shrink-0 px-4 py-3 border-t bg-gradient-to-t from-muted/20 to-transparent">
          <Suspense fallback={<LoadingFallback />}>
            <ActionButtons
              displayedFiles={displayedFiles}
              selectedFilePaths={selectedFilePaths}
              maxSelectionCount={maxSelectionCount}
              currentFolderId={currentFolderId}
              setSelectedFiles={handleSelectionChange}
              encodeFileSelection={encodeFileSelection}
              onSelectionLimitExceeded={() => {}}
              onDownloadReport={handleDownloadReport}
              onCopyReport={handleCopyReport}
            />
          </Suspense>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
});

FileExplorerLeftPanel.displayName = 'FileExplorerLeftPanel';
