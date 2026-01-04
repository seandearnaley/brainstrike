import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import { LoadingFallback } from '@brainstrike/ui';
import { createLogger, encodeFileSelection, parseFilterString } from '@brainstrike/utils';

const logger = createLogger('FileExplorerLeftPanel');

import * as React from 'react';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import ActionButtons from './action-buttons-array-facade';
import { TreeActionButtons } from './components/tree-action-buttons';
import FileExplorerErrorBoundary from './file-explorer-error-boundary';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import FileExplorerSidebar from './file-explorer-sidebar';
import { DirectoryStatus, FilterStatus } from './file-explorer-status-components';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { useInlineFixtureEffect } from './hooks/use-inline-fixture-effect';
import { useRuleMaterialization } from './hooks/use-rule-materialization';
import { RestorationStatus } from './restoration-status';
import { SelectionModeBadge } from './selection-mode-badge';
import { SelectionRulesEditor } from './selection-rules-editor';
import { useBackgroundTokenIndexerIntegration } from './use-background-token-indexer-integration';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';
import { computeScanningStatusProps } from './utils/scanning-status-props';

// Quick filter helpers (factored to keep component complexity low)

/**
 * Check if a node should be included based on filter patterns.
 * IMPORTANT: Both include and exclude patterns match ONLY against the filename
 * to avoid false positives from path components (e.g., "test" matching
 * "test-project/" in the path when only files named "test" should match).
 */
function shouldIncludeNode(node: IFileNode, includes: string[], excludes: string[]): boolean {
  const nameText = node.name.toLowerCase();
  // Excludes only match filename to avoid false positives from path
  if (excludes.some((e) => nameText.includes(e))) {
    return false;
  }
  // Includes also only match filename for consistent behavior
  return includes.length === 0 || includes.some((i) => nameText.includes(i));
}

function filterNodeByPatterns(
  node: IFileNode,
  includes: string[],
  excludes: string[]
): IFileNode | null {
  if (node.type === 'directory') {
    const children = node.children ?? [];
    const filteredChildren = children
      .map((c) => filterNodeByPatterns(c, includes, excludes))
      .filter(Boolean) as IFileNode[];
    if (filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    if (shouldIncludeNode(node, includes, excludes)) {
      return { ...node, children: [] };
    }
    return null;
  }
  return shouldIncludeNode(node, includes, excludes) ? node : null;
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
    currentFolderId,
    setCurrentFolderId,
    maxSelectionCount,
    setMaxSelectionCount,
    devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    setRootDirectoryHandle,
  ] = store(
    (s) =>
      [
        s.includeFilters,
        s.excludeFilters,
        s.useRegex,
        s.currentFolderId,
        s.setCurrentFolderId,
        s.maxSelectionCount,
        s.setMaxSelectionCount,
        s.devInlineFixtureEnabled,
        s.setDevInlineFixtureEnabled,
        s.setRootDirectoryHandle,
      ] as const
  );

  // Local state for UI
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRulesEditorOpen, setIsRulesEditorOpen] = useState(false);

  const {
    fileTree,
    handleRootDirectorySelect,
    isLoading,
    error,
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
    loadingPaths,
    loadChildren,
    cancelChildLoading,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    isRestoringExpandedPaths,
    restorationProgress,
  } = useFileExplorer();

  const {
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    handleSelectionLimitError,
  } = useToastManager();

  const { selectedFilesList, setSelectedFilesFromList } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitError,
  });
  // Back-compat for older test mocks that don't provide new fields
  const safeSelectedFilesList: string[] = Array.isArray(selectedFilesList) ? selectedFilesList : [];
  const safeSetSelectedFilesFromList =
    (setSelectedFilesFromList as undefined | ((l: readonly string[]) => void)) ?? (() => {});

  // Inline fixture state management - extracted to reduce component complexity
  const { isLoading: isInlineFixtureLoading, isAvailable: inlineFixtureAvailable } =
    useInlineFixtureEffect({
      fileSystemAdapter,
      devInlineFixtureEnabled,
      setDevInlineFixtureEnabled,
      setRootDirectoryHandle,
      clearRootDirectory,
      showToast,
      strings: {
        successTitle: FileExplorerStrings.success.title,
        errorTitle: FileExplorerStrings.error.title,
        enableSuccess: FileExplorerStrings.inlineFixture.enableSuccess,
        disableSuccess: FileExplorerStrings.inlineFixture.disableSuccess,
        enableError: FileExplorerStrings.inlineFixture.enableError,
        disableError: FileExplorerStrings.inlineFixture.disableError,
      },
    });

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) {
      return null;
    }
    return new Error(filterError);
  }, [filterError]);

  const stableFileTree = useMemo(() => fileTree || [], [fileTree]);

  // Materialize selection rules against the file tree when in 'rules' mode
  // Note: useRuleMaterialization already uses the single-selector pattern
  // (selects entire selectionModel object once), which is safe for React Compiler.
  useRuleMaterialization({
    fileTree: stableFileTree,
    enabled: !isLoading,
  });

  // Get selection model for rules-based mode token counting and display
  const selectionModel = store((s) => s.selectionModel);

  // Background token indexing - processes selected files off the main thread
  // IMPORTANT: Convert materializedPaths to composite keys when in rules mode
  // The indexer expects composite keys (folderId|@|path format), not relative paths
  const selectedFilesSet = useMemo(() => {
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths && currentFolderId) {
      const compositeKeys = new Set<string>();
      for (const relativePath of selectionModel.materializedPaths) {
        compositeKeys.add(encodeFileSelection(currentFolderId, relativePath));
      }
      return compositeKeys;
    }
    return new Set(safeSelectedFilesList);
  }, [
    selectionModel.mode,
    selectionModel.materializedPaths,
    currentFolderId,
    safeSelectedFilesList,
  ]);

  // Selection count - mode-aware for display purposes
  const selectedCount = useMemo(() => {
    if (selectionModel.mode === 'rules' && selectionModel.materializedPaths) {
      return selectionModel.materializedPaths.size;
    }
    return safeSelectedFilesList.length;
  }, [selectionModel.mode, selectionModel.materializedPaths, safeSelectedFilesList]);

  // Electron file reader - reads file content via IPC for the background worker
  // The worker cannot read files directly in Electron due to security restrictions
  const electronFileReader = useCallback(
    async (handle: { path: string; name: string; kind: 'file'; platform: 'electron' }) =>
      fileSystemAdapter.readFile(handle),
    [fileSystemAdapter]
  );

  // This hook automatically indexes selected files when TokenCacheProvider is present
  // BST-151: Also get reprioritizeVisible for visible file priority indexing
  const { reprioritizeVisible } = useBackgroundTokenIndexerIntegration({
    fileTree: stableFileTree,
    selectedFiles: selectedFilesSet,
    electronFileReader,
  });

  const [quickFilterRaw, setQuickFilterRaw, clearQuickFilterRaw] = store(
    (s) => [s.quickFilter, s.setQuickFilter, s.clearQuickFilter] as const
  );
  const quickFilter = typeof quickFilterRaw === 'string' ? quickFilterRaw : '';
  const setQuickFilter = (setQuickFilterRaw ?? (() => {})) as (v: string) => void;
  const clearQuickFilter = (clearQuickFilterRaw ?? (() => {})) as () => void;

  const inlineFixtureSetting = useMemo(() => {
    if (!inlineFixtureAvailable) {
      return;
    }
    return {
      available: inlineFixtureAvailable,
      loading: isInlineFixtureLoading,
    } as const;
  }, [inlineFixtureAvailable, isInlineFixtureLoading]);

  // Local filtering utility modeled after hooks/use-quick-filter
  const quickFilteredTree = useMemo(() => {
    if (!quickFilter.trim()) {
      return stableFileTree;
    }
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
    if (!rootDirectoryHandle) {
      return;
    }

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
      // applyFileFilters internally calls setFilters and setUseRegex, so no need to call setFilters separately
      applyFileFilters(newIncludeFilters, newExcludeFilters, newUseRegex);
    },
    [applyFileFilters]
  );

  // biome-ignore lint/plugin: Sync folder ID with root directory handle - controlled state update
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
    logger.info('expandAll clicked', {
      isExpandingAll,
      hasFileTree: !!fileTree,
      fileTreeLength: fileTree?.length ?? 0,
    });

    // Prevent clicks while expand-all is already running
    if (isExpandingAll) {
      logger.info('expandAll: blocked - already expanding');
      return;
    }
    if (fileTree && fileTree.length > 0) {
      logger.info('expandAll: calling expandAllProgressively');
      // Use progressive expand-all that loads directories on demand
      const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>) => {
        const currentPaths = store.getState().expandedDirectoryPaths;
        const newPaths = updater(currentPaths);
        store.getState().setExpandedPaths(newPaths);
      };
      void expandAllProgressively(setExpandedPaths);
    } else {
      logger.warn('expandAll: no file tree or empty tree');
    }
  }, [fileTree, store, expandAllProgressively, isExpandingAll]);

  const collapseAll = useCallback(() => {
    // Cancel any in-progress expand-all first
    cancelExpandAll();
    store.getState().collapseAllDirectories();
  }, [store, cancelExpandAll]);

  const handleCancelOperation = useCallback(() => {
    cancelOperation();
    showToast({
      title: 'Operation Cancelled',
      description: 'The file loading operation has been cancelled.',
      variant: 'default',
    });
  }, [cancelOperation, showToast]);

  // Compute scanning status props - extracted to reduce complexity
  const scanningStatusProps = useMemo(
    () =>
      computeScanningStatusProps({
        loadingProgress,
        isExpandingAll,
        expandAllProgress,
        cancellable,
        isCancelling,
        cancelExpandAll,
        handleCancelOperation,
      }),
    [
      loadingProgress,
      isExpandingAll,
      expandAllProgress,
      cancellable,
      isCancelling,
      cancelExpandAll,
      handleCancelOperation,
    ]
  );

  return (
    <FileExplorerErrorBoundary>
      <div className="grid h-full grid-rows-[auto_1fr_auto]">
        {/* Fixed Header */}
        <div className="shrink-0">
          <FileExplorerToolbar
            clearQuickFilter={clearQuickFilter}
            filterError={filterError}
            isLoading={isLoading}
            maxSelectionCount={maxSelectionCount}
            onDirectorySelect={handleDirectorySelect}
            onFilterChange={handleFilterChange}
            onMaxSelectionCountChange={setMaxSelectionCount}
            quickFilter={quickFilter}
            rootDirectoryHandle={rootDirectoryHandle}
            selectedCount={selectedCount}
            setQuickFilter={setQuickFilter}
            {...(inlineFixtureSetting ? { inlineFixtureSetting } : {})}
          />
          <DirectoryStatus rootDirectoryHandle={rootDirectoryHandle} />
          <FilterStatus
            excludeFilters={excludeFilters}
            includeFilters={includeFilters}
            quickFilter={quickFilter}
            useRegex={useRegex}
          />
          {/* Restoration indicator - shown when restoring expanded directories from persisted state */}
          <RestorationStatus
            isRestoring={isRestoringExpandedPaths}
            progress={restorationProgress}
          />
        </div>

        {/* Scrollable Middle Content */}
        <div className="relative min-h-0 flex-1">
          {/* Fixed buttons overlay - outside scrollable area */}
          {rootDirectoryHandle && (
            <TreeActionButtons
              isExpandingAll={isExpandingAll}
              isLoading={isLoading}
              isRefreshing={isRefreshing}
              onCollapseAll={collapseAll}
              onExpandAll={expandAll}
              onRefresh={handleRefresh}
              scanningStatus={scanningStatusProps}
            />
          )}

          {/* Scrollable content */}
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<LoadingFallback />}>
              <FileExplorerSidebar
                cancelChildLoading={cancelChildLoading}
                currentFolderId={currentFolderId}
                filterError={filterErrorAsError}
                isInitialLoad={isInitialLoad}
                isLoading={isLoading}
                loadingFiles={loadingFiles}
                loadingPaths={loadingPaths}
                onLoadChildren={loadChildren}
                onVisibleRangeChange={reprioritizeVisible}
                quickFilteredTree={quickFilteredTree}
                rootDirectoryHandle={rootDirectoryHandle}
                treeError={error}
              />
            </Suspense>
          </div>
        </div>

        {/* Fixed Footer */}
        <div className="shrink-0 border-t bg-gradient-to-t from-muted/20 to-transparent px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <ActionButtons
              currentFolderId={(rootDirectoryHandle?.name ?? currentFolderId) as string | null}
              displayedFiles={displayedFileList}
              encodeFileSelection={encodeFileSelection}
              maxSelectionCount={maxSelectionCount}
              onSelectionLimitExceeded={() => {}}
              selectedFiles={safeSelectedFilesList}
              setSelectedFiles={safeSetSelectedFilesFromList}
            />
            {/* Selection mode toggle */}
            <SelectionModeBadge
              onOpenRulesEditor={() => setIsRulesEditorOpen(true)}
              rulesEditorAvailable={true}
              show={!!rootDirectoryHandle}
            />
          </div>
        </div>

        {/* Selection Rules Editor Dialog */}
        <SelectionRulesEditor
          folderId={(rootDirectoryHandle?.name ?? currentFolderId) || ''}
          isOpen={isRulesEditorOpen}
          onOpenChange={setIsRulesEditorOpen}
        />
      </div>
    </FileExplorerErrorBoundary>
  );
});

FileExplorerLeftPanel.displayName = 'FileExplorerLeftPanel';
