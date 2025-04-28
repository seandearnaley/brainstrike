import type { IFileNode } from '@brainstrike/types';
import { ErrorBoundary } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Suspense, lazy } from 'react';
import { useFileExplorer } from '../../hooks/use-file-explorer';
import { useFileLoadingManager } from '../../hooks/use-file-loading-manager';
import { useQuickFilter } from '../../hooks/use-quick-filter';
import { useReportGeneration } from '../../hooks/use-report-generation';
import { useReportManager } from '../../hooks/use-report-manager';
import { useSelectionManager } from '../../hooks/use-selection-manager';
import { useToastManager } from '../../hooks/use-toast-manager';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { decodeFileSelection } from '../../utils/file-selection-utils';
import { countTokensHeuristic, estimateTokenCost } from '../../utils/token-utils';

// Lazy load heavy components
const ActionButtons = lazy(() =>
  import('@brainstrike/ui').then((m) => ({
    default: m.ActionButtons as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);
const FileExplorerSidebar = lazy(() => import('./file-explorer-sidebar'));

// MIGRATION: FileExplorerMainPanel is now provided by @brainstrike/ui.
// Remove local lazy import and use the UI package version.
const FileExplorerMainPanel = lazy(() =>
  import('@brainstrike/ui').then((m) => ({
    default: m.PreviewPanel as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

// Import lightweight components directly
import { FileExplorerStrings } from './constants/file-explorer-constants';
import { FileExplorerHeader } from './file-explorer-header';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { LoadingOverlay } from './loading-overlay';

// Loading fallback component
const LoadingComponent = () => (
  <div className="flex items-center justify-center h-full">
    <div className="animate-pulse">Loading...</div>
  </div>
);

// Log successful imports to help with debugging
console.log('Core imports loaded successfully');

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
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Add state for tracking which file paths are currently displayed
  const [displayedFiles, setDisplayedFiles] = useState<Set<string>>(new Set());

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
  } = useFileExplorer({ onDisplayedFilePathsChange: setDisplayedFiles });

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) return null;
    return new Error(filterError);
  }, [filterError]);

  const { toast, showToast, handleRefreshError, handleSelectionLimitError } = useToastManager();

  const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitError,
  });

  const {
    quickFilter,
    setQuickFilter,
    filteredTree: quickFilteredTree,
    clearFilter,
  } = useQuickFilter(fileTree);

  useEffect(() => {
    function collectVisiblePaths(nodes: IFileNode[]): Set<string> {
      const paths = new Set<string>();
      if (!Array.isArray(nodes)) {
        return paths;
      }
      for (const node of nodes) {
        if (node.type === 'file') {
          paths.add(node.path);
        } else if (node.type === 'directory' && node.children) {
          const childPaths = collectVisiblePaths(node.children);
          for (const p of childPaths) {
            paths.add(p);
          }
        }
      }
      return paths;
    }

    setDisplayedFiles(
      Array.isArray(quickFilteredTree) ? collectVisiblePaths(quickFilteredTree) : new Set<string>()
    );
  }, [quickFilteredTree]);

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

  const handleRefresh = useCallback(async () => {
    if (!rootDirectoryHandle) return;

    setIsRefreshing(true);
    try {
      await refreshFileExplorer();
      toast({
        title: FileExplorerStrings.SUCCESS.TITLE,
        description: FileExplorerStrings.SUCCESS.REFRESH_SUCCESS,
      });
    } catch (error) {
      handleRefreshError(error);
    } finally {
      setIsRefreshing(false);
    }
  }, [rootDirectoryHandle, refreshFileExplorer, toast, handleRefreshError]);

  const handleDirectorySelect = useCallback(async () => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      toast({
        title: FileExplorerStrings.ERROR.BROWSER_COMPATIBILITY,
        description: reason,
        variant: 'destructive',
      });
      return;
    }
    await handleRootDirectorySelect();
  }, [isFileSystemAccessSupported, toast, handleRootDirectorySelect]);

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
                phase: 'counting',
              }
            }
            className="z-50"
          />
          <div className="flex flex-1 flex-col overflow-hidden gap-4 md:flex-row">
            <div className="w-full md:w-1/2 @container/sidebar flex flex-col overflow-hidden px-2">
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
              <Suspense fallback={<LoadingComponent />}>
                <FileExplorerSidebar
                  rootDirectoryHandle={rootDirectoryHandle}
                  treeError={treeError}
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
              <Suspense fallback={<LoadingComponent />}>
                <FileExplorerMainPanel
                  rootDirectoryHandle={rootDirectoryHandle}
                  selectedFiles={selectedFilePaths}
                  fileContents={fileContents}
                  loadingFiles={loadingFiles}
                  onSelectionChange={handleSelectionChange}
                  decodeFileSelection={decodeFileSelection}
                  countTokensHeuristic={countTokensHeuristic}
                  estimateTokenCost={estimateTokenCost}
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
              encodeFileSelection={() => {}}
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
