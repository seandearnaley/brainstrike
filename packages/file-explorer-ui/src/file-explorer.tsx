import { useFileExplorerToasts } from './hooks/use-file-explorer-toasts';

import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerErrorBoundary } from '@brainstrike/file-explorer-ui';
import { LoadingOverlay } from '@brainstrike/file-explorer-ui';
import { FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { FileExplorerToolbar } from '@brainstrike/file-explorer-ui';
import { useUndoableAction } from '@brainstrike/hooks';
import { useQuickFilter } from '@brainstrike/hooks';
import { useReportGeneration, useReportManager } from '@brainstrike/hooks';
import { LoadingFallback } from '@brainstrike/ui';
import { Button } from '@brainstrike/ui';
import { cn } from '@brainstrike/ui';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils';
import { countTokensHeuristic, estimateTokenCost } from '@brainstrike/utils';
import { ChevronsDown, ChevronsUp, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { Suspense, lazy } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useFileExplorerSelection } from './hooks/use-file-explorer-selection';
import { useFileExplorer } from './use-file-explorer-context';

// Lazy load heavy components
const ActionButtons = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.ActionButtons as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);
const FileExplorerSidebar = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.FileExplorerSidebar as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

const FileExplorerMainPanel = lazy(() =>
  import('@brainstrike/file-explorer-ui').then((m) => ({
    default: m.VirtualizedPreviewPanelTabbed as unknown as React.ComponentType<
      Record<string, unknown>
    >,
  }))
);

/**
 * @file FileExplorer.tsx
 * @description The main orchestrator for the file explorer interface.
 * This component brings together various hooks and UI components (FileTree, FilePreview, etc.)
 * to provide the complete file exploration experience. It manages the overall state of the
 * file explorer, including selected files, expanded folders, and interactions between
 * different parts of the UI.
 */
const FileExplorer: React.FC = () => {
  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
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
  } = store(
    (s) => ({
      includeFilters: s.includeFilters,
      excludeFilters: s.excludeFilters,
      useRegex: s.useRegex,
      maxSelectionCount: s.maxSelectionCount,
      includeProjectTree: s.includeProjectTree,
      folderSummaryThreshold: s.folderSummaryThreshold,
      setFilters: s.setFilters,
      currentFolderId: s.currentFolderId,
      setCurrentFolderId: s.setCurrentFolderId,
    }),
    shallow
  );

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
  } = useFileExplorer({
    onDisplayedFilePathsChange: () => {},
  });

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) return null;
    return new Error(filterError);
  }, [filterError]);

  const {
    toast,
    showToast,
    handleSelectionLimitError,
    isRefreshing,
    handleRefresh,
    handleDirectorySelect,
    handleCancelOperation,
  } = useFileExplorerToasts({
    rootDirectoryHandle,
    refreshFileExplorer,
    handleRootDirectorySelect,
    isFileSystemAccessSupported,
    cancelOperation,
  });

  const {
    quickFilter,
    setQuickFilter,
    filteredTree: quickFilteredTree,
    clearFilter,
  } = useQuickFilter(fileTree);

  const { selectedFilePaths, handleSelectionChange, displayedFiles } = useFileExplorerSelection({
    quickFilteredTree,
    onSelectionLimitExceeded: handleSelectionLimitError,
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

  const { handleDownloadReport, handleCopyReport } = useReportManager({
    rootDirectoryHandle,
    generateReportWithContent,
    showToast,
    toast,
  });

  const { performUndoableAction } = useUndoableAction();

  const performUndoableActionForPanel = (
    key: string,
    _itemKey: string, // renamed to avoid unused var lint
    opts: {
      actionName: string;
      itemDescription: string;
      getStateSnapshot: () => Set<string>;
      onUndo: (key: string, snapshot: Set<string>) => void;
    }
  ) => {
    performUndoableAction(key, opts.getStateSnapshot(), {
      actionName: opts.actionName,
      itemDescription: opts.itemDescription,
      getStateSnapshot: opts.getStateSnapshot,
      // Adapt onUndo signature to match VirtualizedPreviewPanel expectation
      onUndo: (_item: unknown, snapshot: unknown) => opts.onUndo(key, snapshot as Set<string>),
    });
  };

  // Selection and toast logic handled via custom hooks

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

  return (
    <FileExplorerErrorBoundary>
      <div className="@container/main flex flex-col h-full overflow-hidden">
        <FileExplorerHeader />
        <div className="flex-1 flex flex-col overflow-hidden">
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
          <div className="flex flex-1 flex-col overflow-hidden gap-4 md:flex-row">
            <div className="w-full md:w-1/2 @container/sidebar flex flex-col overflow-hidden px-2">
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
              <div className="flex-1 relative">
                {/* Fixed buttons overlay - outside scrollable area */}
                {rootDirectoryHandle && (
                  <div className="absolute top-2 right-6 flex items-center gap-1 z-20">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                      data-testid="refresh-button-small"
                      onClick={handleRefresh}
                      disabled={isLoading || isRefreshing}
                      title="Refresh"
                      aria-label="Refresh"
                    >
                      <RefreshCw className={cn('h-3.5 w-3.5', { 'animate-spin': isRefreshing })} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                      data-testid="expand-all-button-small"
                      onClick={expandAll}
                      disabled={isLoading || isRefreshing}
                      title="Expand All"
                      aria-label="Expand All"
                    >
                      <ChevronsDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm shadow-sm"
                      data-testid="collapse-all-button-small"
                      onClick={collapseAll}
                      disabled={isLoading || isRefreshing}
                      title="Collapse All"
                      aria-label="Collapse All"
                    >
                      <ChevronsUp className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}

                {/* Scrollable content */}
                <div className="overflow-y-auto h-full">
                  <Suspense fallback={<LoadingFallback />}>
                    <FileExplorerSidebar
                      rootDirectoryHandle={rootDirectoryHandle}
                      treeError={error}
                      filterError={filterErrorAsError}
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
                  </Suspense>
                </div>
              </div>
            </div>
            <div className="w-full md:w-1/2 @container/content flex flex-col overflow-hidden border-t md:border-t-0 md:border-l px-2 bg-card/50">
              <Suspense fallback={<LoadingFallback />}>
                <FileExplorerMainPanel
                  rootDirectoryHandle={rootDirectoryHandle}
                  selectedFiles={selectedFilePaths}
                  fileContents={fileContents}
                  loadingFiles={loadingFiles}
                  onSelectionChange={handleSelectionChange}
                  decodeFileSelection={decodeFileSelection}
                  countTokensHeuristic={countTokensHeuristic}
                  estimateTokenCost={estimateTokenCost}
                  performUndoableAction={performUndoableActionForPanel}
                />
              </Suspense>
            </div>
          </div>
          <footer className="px-4 lg:px-6 mt-4 py-3 border-t bg-gradient-to-t from-muted/20 to-transparent">
            <ActionButtons
              displayedFiles={displayedFiles}
              selectedFilePaths={selectedFilePaths}
              maxSelectionCount={maxSelectionCount}
              currentFolderId={currentFolderId}
              setSelectedFiles={handleSelectionChange}
              encodeFileSelection={encodeFileSelection}
              onSelectionLimitExceeded={handleSelectionLimitError}
              onDownloadReport={handleDownloadReport}
              onCopyReport={handleCopyReport}
            />
          </footer>
        </div>
      </div>
    </FileExplorerErrorBoundary>
  );
};

export default FileExplorer;
