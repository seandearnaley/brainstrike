import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import { isFixtureCapableAdapter } from '@brainstrike/file-system';
import { useReportGeneration, useReportManager } from '@brainstrike/hooks';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import {
  Button,
  cn,
  LoadingFallback,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { createLogger, encodeFileSelection, parseFilterString } from '@brainstrike/utils';
import { ChevronsDown, ChevronsUp, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileExplorerErrorBoundary from './file-explorer-error-boundary';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { DirectoryStatus, FilterStatus } from './file-explorer-status-components';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { LoadingOverlay } from './loading-overlay';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

// Lazy load the sidebar component (relative import to avoid duplicate module graphs/context)
const logger = createLogger('FileExplorerLeftPanel');

const FileExplorerSidebar = lazy(() =>
  import('./file-explorer-sidebar').then((m) => ({
    default: (m.default || m) as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

// Lazy load array facade for action buttons
const ActionButtons = lazy(() =>
  import('./action-buttons-array-facade').then((m) => ({
    default: (m.default || m) as unknown as React.ComponentType<Record<string, unknown>>,
  }))
);

// Quick filter helpers (factored to keep component complexity low)
function createSearchableText(node: IFileNode): string {
  return `${node.name.toLowerCase()} ${node.path.toLowerCase()}`;
}

function shouldInclude(text: string, includes: string[], excludes: string[]): boolean {
  if (excludes.some((e) => text.includes(e))) return false;
  return includes.length === 0 || includes.some((i) => text.includes(i));
}

function filterNodeByPatterns(
  node: IFileNode,
  includes: string[],
  excludes: string[]
): IFileNode | null {
  const text = createSearchableText(node);
  if (node.type === 'directory') {
    const children = node.children ?? [];
    const filteredChildren = children
      .map((c) => filterNodeByPatterns(c, includes, excludes))
      .filter(Boolean) as IFileNode[];
    if (filteredChildren.length > 0) return { ...node, children: filteredChildren };
    if (shouldInclude(text, includes, excludes)) return { ...node, children: [] };
    return null;
  }
  return shouldInclude(text, includes, excludes) ? node : null;
}

function filterTreeByPatterns(
  nodes: IFileNode[],
  includes: string[],
  excludes: string[]
): IFileNode[] {
  return nodes
    .map((n) => filterNodeByPatterns(n, includes, excludes))
    .filter(Boolean) as IFileNode[];
}

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
  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  const [
    includeFilters,
    excludeFilters,
    useRegex,
    setFilters,
    currentFolderId,
    setCurrentFolderId,
    maxSelectionCount,
    includeProjectTree,
    folderSummaryThreshold,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    setRootDirectoryHandle,
  ] = store(
    (s) =>
      [
        s.includeFilters,
        s.excludeFilters,
        s.useRegex,
        s.setFilters,
        s.currentFolderId,
        s.setCurrentFolderId,
        s.maxSelectionCount,
        s.includeProjectTree,
        s.folderSummaryThreshold,
        s.devInlineFixtureEnabled,
        s.setDevInlineFixtureEnabled,
        s.setRootDirectoryHandle,
      ] as const
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
    clearRootDirectory,
  } = useFileExplorer();

  const onSelectionLimitExceeded = useCallback(() => {
    // Selection limit handling is managed by action buttons
  }, []);

  const { selectedFilesList, setSelectedFilesFromList } = useSelectionManager({
    onSelectionLimitExceeded,
  });
  // Back-compat for older test mocks that don't provide new fields
  const safeSelectedFilesList: string[] = Array.isArray(selectedFilesList) ? selectedFilesList : [];
  const safeSetSelectedFilesFromList =
    (setSelectedFilesFromList as undefined | ((l: readonly string[]) => void)) ?? (() => {});

  const fixtureAdapter = isFixtureCapableAdapter(fileSystemAdapter) ? fileSystemAdapter : null;
  const inlineFixtureAvailable = Boolean(fixtureAdapter?.canLoadInlineFixture);
  const [isInlineFixtureLoading, setIsInlineFixtureLoading] = useState(false);
  const hasAppliedInitialFixtureRef = useRef(false);

  // Report generation configured with current state
  const { generateReportWithContent } = useReportGeneration({
    selectedFiles: new Set(selectedFilesList),
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

  // We no longer surface these here; wired in PreviewPanel footer instead.
  // Keeping creation here would be unused, so omit to satisfy TS strict mode.

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) return null;
    return new Error(filterError);
  }, [filterError]);

  const stableFileTree = useMemo(() => fileTree || [], [fileTree]);

  const [quickFilterRaw, setQuickFilterRaw, clearQuickFilterRaw] = store(
    (s) => [s.quickFilter, s.setQuickFilter, s.clearQuickFilter] as const
  );
  const quickFilter = typeof quickFilterRaw === 'string' ? quickFilterRaw : '';
  const setQuickFilter = (setQuickFilterRaw ?? (() => {})) as (v: string) => void;
  const clearQuickFilter = (clearQuickFilterRaw ?? (() => {})) as () => void;

  const inlineFixtureSetting = useMemo(() => {
    if (!inlineFixtureAvailable) {
      return undefined;
    }
    return {
      available: inlineFixtureAvailable,
      loading: isInlineFixtureLoading,
    } as const;
  }, [inlineFixtureAvailable, isInlineFixtureLoading]);

  // Local filtering utility modeled after hooks/use-quick-filter
  const quickFilteredTree = useMemo(() => {
    if (!quickFilter.trim()) return stableFileTree;
    const { includes, excludes } = parseFilterString(quickFilter);
    return filterTreeByPatterns(stableFileTree, includes, excludes);
  }, [quickFilter, stableFileTree]);

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
  const displayedFileList = useMemo(() => Array.from(displayedFiles), [displayedFiles]);

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

  const clearRootDirectoryRef = useRef(clearRootDirectory);
  const showToastRef = useRef(showToast);

  useEffect(() => {
    clearRootDirectoryRef.current = clearRootDirectory;
  }, [clearRootDirectory]);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  const enableInlineFixture = useCallback(async () => {
    if (!fixtureAdapter) return;
    const handle = await fixtureAdapter.loadInlineFixture();
    if (handle && setRootDirectoryHandle) {
      // Setting the root directory handle will automatically trigger the file tree to load
      setRootDirectoryHandle(handle);
    }
  }, [fixtureAdapter, setRootDirectoryHandle]);

  const disableInlineFixture = useCallback(async () => {
    if (!fixtureAdapter) return;
    await fixtureAdapter.clearInlineFixture();
    clearRootDirectoryRef.current?.();
  }, [fixtureAdapter]);

  const notifySuccess = useCallback((enabled: boolean) => {
    if (!hasAppliedInitialFixtureRef.current) {
      return;
    }
    const description = enabled
      ? FileExplorerStrings.inlineFixture.enableSuccess
      : FileExplorerStrings.inlineFixture.disableSuccess;
    showToastRef.current?.({
      title: FileExplorerStrings.success.title,
      description,
    });
  }, []);

  const notifyError = useCallback((enabled: boolean) => {
    const description = enabled
      ? FileExplorerStrings.inlineFixture.enableError
      : FileExplorerStrings.inlineFixture.disableError;
    showToastRef.current?.({
      title: FileExplorerStrings.error.title,
      description,
      variant: 'destructive',
    });
  }, []);

  const prevTargetStateRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!fixtureAdapter || !inlineFixtureAvailable) {
      if (devInlineFixtureEnabled) {
        setDevInlineFixtureEnabled(false);
      }
      return;
    }

    if (!hasAppliedInitialFixtureRef.current && !devInlineFixtureEnabled) {
      return;
    }

    if (
      prevTargetStateRef.current === devInlineFixtureEnabled &&
      hasAppliedInitialFixtureRef.current
    ) {
      return;
    }
    prevTargetStateRef.current = devInlineFixtureEnabled;

    let isCancelled = false;
    const targetState = devInlineFixtureEnabled;
    // Avoid re-applying the same state if the fixture is already in the desired state.
    // This prevents the effect from running when unrelated dependencies (like the adapter)
    // change after the initial application.
    const currentActive = fixtureAdapter?.isInlineFixtureActive?.() ?? false;
    if (currentActive === targetState) {
      // Mark that we've applied the initial fixture so future toggles work correctly,
      // but skip the async work since nothing needs to change.
      hasAppliedInitialFixtureRef.current = true;
      return;
    }

    const applySetting = async () => {
      setIsInlineFixtureLoading(true);
      try {
        if (targetState) {
          await enableInlineFixture();
        } else {
          await disableInlineFixture();
        }
        notifySuccess(targetState);
        hasAppliedInitialFixtureRef.current = true;
      } catch (error) {
        logger.warn('Failed to toggle inline fixture', { error, targetState });
        notifyError(targetState);
        setDevInlineFixtureEnabled(!targetState);
      } finally {
        if (!isCancelled) {
          setIsInlineFixtureLoading(false);
        }
        hasAppliedInitialFixtureRef.current = true;
      }
    };

    void applySetting();

    return () => {
      isCancelled = true;
    };
  }, [
    devInlineFixtureEnabled,
    disableInlineFixture,
    enableInlineFixture,
    inlineFixtureAvailable,
    notifyError,
    notifySuccess,
    setDevInlineFixtureEnabled,
    fixtureAdapter,
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
      const id = rootDirectoryHandle.name;
      const currentState = store.getState();
      if (currentState.currentFolderId !== id) {
        // set id synchronously (no extra async)
        setCurrentFolderId(id);
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
            clearQuickFilter={clearQuickFilter}
            isLoading={isLoading}
            rootDirectoryHandle={rootDirectoryHandle}
            selectedCount={safeSelectedFilesList.length}
            maxSelectionCount={maxSelectionCount}
            {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
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
              displayedFiles={displayedFileList}
              selectedFiles={safeSelectedFilesList}
              maxSelectionCount={maxSelectionCount}
              currentFolderId={(rootDirectoryHandle?.name ?? currentFolderId) as string | null}
              setSelectedFiles={safeSetSelectedFilesFromList}
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
