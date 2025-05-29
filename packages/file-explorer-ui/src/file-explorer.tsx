import { useToastManager } from '@brainstrike/file-explorer-hooks';
import { useFileLoadingManager } from '@brainstrike/file-explorer-hooks';
import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { FileExplorerErrorBoundary } from '@brainstrike/file-explorer-ui';
import { LoadingOverlay } from '@brainstrike/file-explorer-ui';
import { FileExplorerHeader } from '@brainstrike/file-explorer-ui';
import { FileExplorerToolbar } from '@brainstrike/file-explorer-ui';
import { useUndoableAction } from '@brainstrike/hooks';
import { useQuickFilter } from '@brainstrike/hooks';
import { useReportGeneration, useReportManager } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { FileExplorerStrings } from '@brainstrike/types';
import { LoadingFallback } from '@brainstrike/ui';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils';
import { countTokensHeuristic, estimateTokenCost } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Suspense, lazy } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

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
    default: m.PreviewPanel as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

// Log successful imports to help with debugging
console.log('Core imports loaded successfully');

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
  } = store();

  // Local state for UI
  const [displayedFiles, setDisplayedFiles] = useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);

  const {
    fileTree,
    handleRootDirectorySelect,
    isLoading,
    error,
    fileContents,
    applyFileFilters,
    filterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    loadFileContent,
    refreshFileExplorer,
    isInitialLoad,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
  } = useFileExplorer({
    onDisplayedFilePathsChange: setDisplayedFiles,
  });

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) return null;
    return new Error(filterError);
  }, [filterError]);

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
      // Adapt onUndo signature to match PreviewPanel expectation
      onUndo: (_item: unknown, snapshot: unknown) => opts.onUndo(key, snapshot as Set<string>),
    });
  };

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
      <div className="@container/main flex flex-col h-full max-h-[calc(100vh-2rem)] overflow-hidden">
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
                onRefresh={handleRefresh}
                onFilterChange={handleFilterChange}
                filterError={filterError}
                quickFilter={quickFilter}
                setQuickFilter={setQuickFilter}
                clearQuickFilter={clearFilter}
                isLoading={isLoading}
                isRefreshing={isRefreshing}
                rootDirectoryHandle={rootDirectoryHandle}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
              />
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
