import { useAdapters, useRestoreAccess, useToastManager } from '@brainstrike/file-explorer-hooks';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import { Button, cn, LoadingFallback } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { parseFilterString } from '@brainstrike/utils/quick-filter-utils';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import type { StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

const logger = createLogger('FileExplorerPanel');
const FILE_EXPLORER_REFRESH_EVENT = 'brainstrike:file-explorer-refreshed';

/**
 * Type for Zustand store with persist middleware.
 * The persist middleware adds a `.persist` property with hydration methods.
 */
interface ZustandPersistApi {
  hasHydrated: () => boolean;
  onFinishHydration: (cb: () => void) => () => void;
}

type StoreWithPersist<T> = UseBoundStoreWithEqualityFn<StoreApi<T>> & {
  persist: ZustandPersistApi;
};

import * as React from 'react';
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ActionButtons from '../action-buttons-array-facade';
import { RestoreAccessModal } from '../components/restore-access-modal';
import { TreeActionButtons } from '../components/tree-action-buttons';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { FilterStatus } from '../file-explorer-status-components';
import { useRuleMaterialization } from '../hooks/use-rule-materialization';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';
import { RestorationStatus } from '../restoration-status';
import { SelectionCounter } from '../selection-counter';
import { SelectionModeBadge } from '../selection-mode-badge';
import { SelectionRulesEditor } from '../selection-rules-editor';
import { ToolbarPresetSelector } from '../toolbar-preset-selector';
import { getRootFolderId } from '../utils/get-root-folder-id';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';
import { computeScanningStatusProps } from '../utils/scanning-status-props';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import FileExplorerSidebar from './file-explorer-sidebar';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { FileFilterBar } from './file-filter-bar';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

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
  includesLower: string[],
  excludesLower: string[]
): IFileNode | null {
  // CRITICAL: Check if this node is excluded FIRST (before processing children)
  // This ensures excluded directories like .turbo are completely removed
  // even if they contain files that would otherwise match include filters
  const nameText = node.name.toLowerCase();
  const isExcluded = excludesLower.some((e) => nameText.includes(e));
  if (isExcluded) {
    return null;
  }

  if (node.type === 'directory') {
    const children = node.children ?? [];
    const filteredChildren = children
      .map((c) => filterNodeByPatterns(c, includesLower, excludesLower))
      .filter(Boolean) as IFileNode[];
    if (filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    // Empty directory - check if it passes include filter
    if (shouldIncludeNode(node, includesLower, excludesLower)) {
      return { ...node, children: [] };
    }
    return null;
  }
  // For files, check include filter (exclude already checked above)
  return includesLower.length === 0 || includesLower.some((i) => nameText.includes(i))
    ? node
    : null;
}

function filterTreeByPatterns(
  nodes: IFileNode[],
  includesLower: string[],
  excludesLower: string[]
): IFileNode[] {
  return nodes
    .map((n) => filterNodeByPatterns(n, includesLower, excludesLower))
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

const EMPTY_DISPLAYED_FILE_LIST: string[] = [];
const LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD = 250;

/**
 * FileExplorerPanel - Contains the file tree and toolbar
 * This component can be used independently in a panel of an IDE layout
 */
export const FileExplorerPanel: React.FC = React.memo(() => {
  const { fileSystemAdapter, storageAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  const [
    includeFilters,
    excludeFilters,
    useRegex,
    setFilters,
    setUseRegex,
    currentFolderId,
    setCurrentFolderId,
    hydrateFolderState,
    maxSelectionCount,
    setMaxSelectionCount,
    _devInlineFixtureEnabled,
    setDevInlineFixtureEnabled,
    disabledIncludeFilters,
    disabledExcludeFilters,
    toggleFilterEnabled,
    isFiltersExpanded,
    setFiltersExpanded,
  ] = useFileExplorerStoreSelector(
    (s) =>
      [
        s.includeFilters,
        s.excludeFilters,
        s.useRegex,
        s.setFilters,
        s.setUseRegex,
        s.currentFolderId,
        s.setCurrentFolderId,
        s.hydrateFolderState,
        s.maxSelectionCount,
        s.setMaxSelectionCount,
        s.devInlineFixtureEnabled,
        s.setDevInlineFixtureEnabled,
        s.disabledIncludeFilters,
        s.disabledExcludeFilters,
        s.toggleFilterEnabled,
        s.isFiltersExpanded,
        s.setFiltersExpanded,
      ] as const,
    shallow
  );

  const handleMaxSelectionCountChange = useCallback(
    (count: number) => {
      setMaxSelectionCount(count);
      void persistFileExplorerStateImmediately(store, storageAdapter).catch((error: unknown) => {
        logger.error('Failed to persist max selection count immediately', { error });
      });
    },
    [setMaxSelectionCount, store, storageAdapter]
  );

  // Local state for UI
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRulesEditorOpen, setIsRulesEditorOpen] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const previousRootFolderIdRef = useRef<string | null>(null);

  const {
    fileTree,
    handleRootDirectorySelect,
    isLoading,
    error,
    loadingFiles,
    filterError,
    rootDirectoryHandle,
    isFileSystemAccessSupported,
    refreshFileExplorer,
    isInitialLoad,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
    clearRootDirectory: _clearRootDirectory,
    setRootDirectoryHandle,
    loadingPaths,
    loadChildren,
    cancelChildLoading,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    isRestoringExpandedPaths,
    restorationProgress,
    setAccessLoading,
    selectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
  } = useFileExplorer();

  const {
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
    storedFolders,
    beginRestore,
    dismissRestore,
  } = useRestoreAccess();

  // CRITICAL: Block stale clearing effect as soon as restore modal becomes visible.
  // The stale clearing effect runs after 1500ms if no rootDirectoryHandle exists.
  // If we wait until the user clicks "Restore Access" to set isAccessLoading,
  // the expanded paths will already have been cleared by then. Also block stale
  // clearing while we are still checking IndexedDB for stored handles.
  useEffect(() => {
    if (isCheckingStoredHandles || pendingRestore || showDeniedBanner || showStaleBanner) {
      setAccessLoading(true);
      return;
    }
    if (!rootDirectoryHandle) {
      setAccessLoading(false);
    }
  }, [
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
    rootDirectoryHandle,
    setAccessLoading,
  ]);

  const {
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
  } = useToastManager();

  // Get store actions for recursive folder selection
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const addMultipleSelectedFilesChunked = useFileExplorerStoreSelector(
    (s) => s.addMultipleSelectedFilesChunked
  );
  const { selectedCount, selectedFilePaths, selectedFilesList, setSelectedFilesFromList } =
    useSelectionManager();

  // Wrapper for recursive folder selection that binds store actions
  // This allows FileExplorerSidebar to call with just the node
  const handleSelectFolderRecursively = useCallback(
    async (node: IFileNode) => {
      const folderId = getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? '';
      const selectedDescendantCount = selectedFilesList.filter((selectionKey) =>
        selectionKey.startsWith(`${folderId}|@|${node.path}/`)
      ).length;
      return selectFolderRecursively(
        node,
        folderId,
        addMultipleSelectedFiles,
        maxSelectionCount,
        selectedCount,
        selectedDescendantCount,
        addMultipleSelectedFilesChunked
      );
    },
    [
      selectFolderRecursively,
      rootDirectoryHandle,
      currentFolderId,
      addMultipleSelectedFiles,
      addMultipleSelectedFilesChunked,
      maxSelectionCount,
      selectedCount,
      selectedFilesList,
    ]
  );

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
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);

  const largeSelectionDiagnosticSignatureRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeFileExplorerTestHooks__ = {
      getSnapshot: () => ({
        currentFolderId,
        rootDirectoryPath: rootDirectoryHandle?.path ?? null,
        selectionMode: selectionModel.mode,
        selectedFilePathCount: selectedFilePaths.size,
        selectedFilePathSamples: Array.from(selectedFilePaths).slice(0, 5),
        materializedPathCount: selectionModel.materializedPaths?.size ?? 0,
        materializedPathSamples: Array.from(selectionModel.materializedPaths ?? []).slice(0, 5),
        treeRootCount: stableFileTree.length,
        treeSamples: stableFileTree.slice(0, 5).map((node) => ({
          path: node.path,
          type: node.type,
          rootFolderId: node.rootFolderId ?? null,
          childCount: node.children?.length ?? 0,
        })),
      }),
    };

    return () => {
      window.__brainstrikeFileExplorerTestHooks__ = undefined;
    };
  }, [
    currentFolderId,
    rootDirectoryHandle,
    selectionModel.mode,
    selectionModel.materializedPaths,
    selectedFilePaths,
    stableFileTree,
  ]);

  // Electron file reader - reads file content via IPC for the background worker
  // The worker cannot read files directly in Electron due to security restrictions
  const electronFileReader = useCallback(
    async (handle: { path: string; name: string; kind: 'file'; platform: 'electron' }) =>
      fileSystemAdapter.readFile(handle),
    [fileSystemAdapter]
  );

  // Web file resolver - mirrors the desktop synthetic-handle path so the
  // background indexer can index files inside lazy/unexpanded subfolders (e.g.
  // after Select All) without forcing the whole tree to expand on the main
  // thread. Only wired when the active adapter implements the optional
  // resolveFileForIndexing capability (web today; electron leaves it undefined
  // and continues using electronFileReader). The union return value lets
  // production return a real `FileSystemFileHandle` (worker-side read) while
  // in-memory adapters return pre-loaded `kind: 'content'` because their
  // synthetic handles cannot survive structured clone to the worker.
  const adapterResolveFileForIndexing = fileSystemAdapter.resolveFileForIndexing;
  const webFileHandleResolver = useMemo(
    () =>
      adapterResolveFileForIndexing
        ? (absolutePath: string) =>
            adapterResolveFileForIndexing.call(fileSystemAdapter, absolutePath)
        : undefined,
    [adapterResolveFileForIndexing, fileSystemAdapter]
  );

  // This hook automatically indexes selected files when TokenCacheProvider is present.
  // Only pass `webFileHandleResolver` when the active adapter advertises it so we don't
  // trip `exactOptionalPropertyTypes` with an explicit-`undefined` value.
  useBackgroundTokenIndexerIntegration({
    fileTree: stableFileTree,
    selectedFiles: selectedFilePaths,
    electronFileReader,
    ...(webFileHandleResolver ? { webFileHandleResolver } : {}),
  });

  const [quickFilter, setQuickFilter, clearQuickFilter] = useFileExplorerStoreSelector(
    (s) => [s.quickFilter, s.setQuickFilter, s.clearQuickFilter] as const
  );

  // Defer the quick filter value to keep typing responsive on large trees.
  // The expensive tree filtering will happen in a lower-priority render while
  // the input remains responsive to user keystrokes.
  const deferredQuickFilter = useDeferredValue(quickFilter);
  const isQuickFiltering = deferredQuickFilter !== quickFilter;

  // Quick filter (search box) applies on top of workspace filters.
  // Workspace filters are already applied in useFileExplorer() which returns
  // fileTree with excluded directories (like .turbo) completely removed.
  // Uses deferredQuickFilter so tree filtering is deferred behind UI updates.
  const quickFilteredTree = useMemo(() => {
    if (!stableFileTree) {
      return null;
    }

    // Only apply quick filter (search box) if present
    if (!deferredQuickFilter.trim()) {
      return stableFileTree;
    }

    const { includes, excludes } = parseFilterString(deferredQuickFilter);
    const includesLower = includes.map((value: string) => value.toLowerCase());
    const excludesLower = excludes.map((value: string) => value.toLowerCase());
    return filterTreeByPatterns(stableFileTree, includesLower, excludesLower);
  }, [deferredQuickFilter, stableFileTree]);

  const visibleFilePaths = useMemo(() => {
    const visible = new Set<string>();
    if (quickFilteredTree) {
      collectVisibleFiles(quickFilteredTree, visible);
    }
    return Array.from(visible);
  }, [quickFilteredTree]);

  // displayedFiles are only needed by the legacy "fallback select-all" path.
  // In desktop, recursive select-all should always be available and this stays false.
  // Keep a runtime capability check so tests and non-desktop adapters can still exercise fallback.
  const hasRecursiveSelectAll =
    typeof (selectAllRecursively as unknown) === 'function' &&
    typeof (addMultipleSelectedFiles as unknown) === 'function';
  const useFallbackDisplayedFiles = !hasRecursiveSelectAll;

  const displayedFileList = useMemo(() => {
    if (!useFallbackDisplayedFiles) {
      return EMPTY_DISPLAYED_FILE_LIST;
    }
    return visibleFilePaths;
  }, [visibleFilePaths, useFallbackDisplayedFiles]);

  useEffect(() => {
    const materializedPathCount = selectionModel.materializedPaths?.size ?? 0;
    const treeRootCount = stableFileTree.length;
    const shouldLog =
      selectedCount >= LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD ||
      materializedPathCount >= LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD ||
      treeRootCount >= LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD;
    if (!shouldLog) {
      largeSelectionDiagnosticSignatureRef.current = null;
      return;
    }

    const diagnosticSignature = [
      selectionModel.mode,
      currentFolderId ?? 'none',
      selectedCount,
      selectedFilePaths.size,
      materializedPathCount,
      treeRootCount,
      quickFilteredTree?.length ?? 0,
      useFallbackDisplayedFiles ? displayedFileList.length : -1,
    ].join('|');
    if (largeSelectionDiagnosticSignatureRef.current === diagnosticSignature) {
      return;
    }
    largeSelectionDiagnosticSignatureRef.current = diagnosticSignature;

    logger.info('Large file explorer selection rendered', {
      selectionMode: selectionModel.mode,
      currentFolderId,
      selectedCount,
      selectedFilePathsCount: selectedFilePaths.size,
      materializedPathCount,
      treeRootCount,
      quickFilteredTreeRootCount: quickFilteredTree?.length ?? 0,
      fallbackDisplayedFileCount: useFallbackDisplayedFiles ? displayedFileList.length : null,
      expandAllInProgress: isExpandingAll,
      loadingPathCount: loadingPaths.size,
      isLoading,
      isLoadingForSelection,
      isLoadingForSelectAll,
      isQuickFiltering,
    });
  }, [
    currentFolderId,
    displayedFileList.length,
    isExpandingAll,
    isLoading,
    isLoadingForSelectAll,
    isLoadingForSelection,
    isQuickFiltering,
    loadingPaths.size,
    quickFilteredTree,
    selectedCount,
    selectedFilePaths,
    selectionModel.materializedPaths,
    selectionModel.mode,
    stableFileTree.length,
    useFallbackDisplayedFiles,
  ]);

  const handleRefresh = useCallback(async () => {
    if (!rootDirectoryHandle) {
      return;
    }

    setIsRefreshing(true);
    try {
      await refreshFileExplorer();
      window.dispatchEvent(new CustomEvent(FILE_EXPLORER_REFRESH_EVENT));
      showToast({
        title: FileExplorerStrings.success.title,
        description: FileExplorerStrings.success.refreshSuccess,
      });
      setIsRefreshing(false);
    } catch (error) {
      handleRefreshError(error);
      setIsRefreshing(false);
    }
  }, [rootDirectoryHandle, refreshFileExplorer, showToast, handleRefreshError]);

  const handleDirectorySelect = useCallback(async () => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      // Fall back to inline fixture demo mode when the directory picker is unavailable.
      // Check for loadInlineFixture to detect a fixture-capable adapter without importing
      // from @brainstrike/file-system (avoids circular dep in this package boundary).
      const adapterAsFixture = fileSystemAdapter as { loadInlineFixture?: unknown };
      if (typeof adapterAsFixture.loadInlineFixture === 'function') {
        setDevInlineFixtureEnabled(true);
        showToast({
          title: FileExplorerStrings.inlineFixture.noAccessFallbackTitle,
          description: FileExplorerStrings.inlineFixture.noAccessFallbackDescription,
        });
        return null;
      }
      handleBrowserCompatibilityError(reason);
      return null;
    }

    try {
      const handle = await handleRootDirectorySelect();
      if (handle === null) {
        // User cancelled the directory selection, do nothing
        return null;
      }
      return handle;
    } catch (error) {
      handleDirectorySelectError(error);
      return null;
    }
  }, [
    handleRootDirectorySelect,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
    isFileSystemAccessSupported,
    fileSystemAdapter,
    setDevInlineFixtureEnabled,
    showToast,
  ]);

  const handleChooseDifferentFolderFromRestore = useCallback(async () => {
    const handle = await handleDirectorySelect();
    if (handle === null) {
      return;
    }
    dismissRestore();
  }, [dismissRestore, handleDirectorySelect]);

  const handleToolbarDirectorySelect = useCallback(async (): Promise<void> => {
    await handleDirectorySelect();
  }, [handleDirectorySelect]);

  const handleFilterChange = useCallback(
    (newIncludeFilters: string[], newExcludeFilters: string[], newUseRegex: boolean) => {
      // Avoid forcing a synchronous full-tree filter pass on preset changes.
      // We only update filter state here; deferred filtering happens in useFileExplorer().
      setFilters(newIncludeFilters, newExcludeFilters);
      setUseRegex(newUseRegex);
    },
    [setFilters, setUseRegex]
  );

  useEffect(() => {
    if (rootDirectoryHandle) {
      const id = getRootFolderId(rootDirectoryHandle);
      if (!id) {
        // Throwing synchronously inside useEffect bypasses React error boundaries.
        // Log the invariant violation and bail out instead of crashing the tree.
        logger.error('Root directory handle is missing its canonical path', {
          handleName: rootDirectoryHandle.name,
        });
        return;
      }
      const previousRootFolderId = previousRootFolderIdRef.current;
      previousRootFolderIdRef.current = id;
      const currentState = store.getState();
      if (currentState.currentFolderId !== id) {
        // set id synchronously (no extra async)
        setCurrentFolderId(id);
      } else if (previousRootFolderId === null && currentState.folderStates[id]) {
        // Rehydrate the persisted folder state when the root handle is restored after
        // top-level selection state may have been cleared during the no-handle window.
        hydrateFolderState(id);
      }
    } else {
      previousRootFolderIdRef.current = null;
      // CRITICAL: Don't clear currentFolderId if we're waiting for restore access.
      // When the page loads with stored handles but no permission yet, we need to
      // preserve the currentFolderId so that the per-folder expandedDirectoryPaths
      // remain intact. Calling setCurrentFolderId(null) triggers buildResetState()
      // which clears expandedDirectoryPaths.
      //
      // isCheckingStoredHandles: true during the initial 500ms while useRestoreAccess
      // checks IndexedDB for stored handles. Don't clear during this time.
      const isWaitingForRestore =
        isCheckingStoredHandles || pendingRestore || showDeniedBanner || showStaleBanner;
      const hasRecoverablePersistedFolder =
        currentFolderId !== null && Boolean(store.getState().folderStates[currentFolderId]);
      if (!(isWaitingForRestore || hasRecoverablePersistedFolder)) {
        setCurrentFolderId(null);
      }
    }
  }, [
    rootDirectoryHandle,
    setCurrentFolderId,
    hydrateFolderState,
    store,
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
  ]);

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
      const currentExpandedPaths = store.getState().expandedDirectoryPaths;
      const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>) => {
        const currentPaths = store.getState().expandedDirectoryPaths;
        const newPaths = updater(currentPaths);
        if (newPaths === currentPaths) {
          return;
        }
        store.getState().setExpandedPaths(newPaths);
      };
      void expandAllProgressively(setExpandedPaths, currentExpandedPaths);
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
        {/* Fixed Header - Toolbar and filter controls */}
        <div className="shrink-0">
          <FileExplorerToolbar
            isLoading={isLoading}
            onDirectorySelect={handleToolbarDirectorySelect}
            rootDirectoryHandle={rootDirectoryHandle}
          />
          {/* Restoration indicator - shown when restoring expanded directories from persisted state */}
          <RestorationStatus
            isRestoring={isRestoringExpandedPaths}
            progress={restorationProgress}
          />
          {/* Filter section: Collapsible view filters + Quick filter input */}
          {rootDirectoryHandle && (
            <div className="border-b">
              {/* View Filters - Collapsible toggle button */}
              <Button
                aria-controls="view-filters-content"
                aria-expanded={isFiltersExpanded}
                aria-label={`${isFiltersExpanded ? 'Collapse' : 'Expand'} view filters`}
                className="h-auto w-full justify-between rounded-none px-3 py-2 hover:bg-muted/50"
                depress={false}
                onClick={() => setFiltersExpanded(!isFiltersExpanded)}
                size="sm"
                variant="ghost"
              >
                <span className="flex items-center gap-2 text-muted-foreground text-xs">
                  <SlidersHorizontal className="h-3 w-3" />
                  View Filters
                </span>
                {isFiltersExpanded ? (
                  <ChevronUp className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                )}
              </Button>

              {/* Collapsible content - Preset selector + Filter chips */}
              <div
                className={cn(
                  'overflow-hidden transition-[max-height,opacity] duration-200 ease-out',
                  isFiltersExpanded ? 'max-h-64 opacity-100' : 'max-h-0 opacity-0'
                )}
                id="view-filters-content"
              >
                <div className="space-y-2 px-2 py-2">
                  <ToolbarPresetSelector
                    className="@[300px]:h-9 h-8 w-full"
                    onFilterChange={handleFilterChange}
                  />
                  <FilterStatus
                    disabledExcludeFilters={disabledExcludeFilters}
                    disabledIncludeFilters={disabledIncludeFilters}
                    excludeFilters={excludeFilters}
                    includeFilters={includeFilters}
                    onToggleFilter={toggleFilterEnabled}
                    quickFilter={quickFilter}
                    useRegex={useRegex}
                  />
                </div>
              </div>

              {/* Quick filter input - always visible. The tree action buttons
                  (refresh / expand / collapse) live inline in this row, next to
                  the syntax-help button, instead of floating over the tree. */}
              <div className="px-2 py-2">
                <FileFilterBar
                  isFiltering={isQuickFiltering}
                  onChange={setQuickFilter}
                  onClear={clearQuickFilter}
                  trailing={
                    <TreeActionButtons
                      isExpandingAll={isExpandingAll}
                      isLoading={isLoading}
                      isRefreshing={isRefreshing}
                      onCollapseAll={collapseAll}
                      onExpandAll={expandAll}
                      onRefresh={handleRefresh}
                      scanningStatus={scanningStatusProps}
                    />
                  }
                  value={quickFilter}
                />
              </div>
            </div>
          )}
        </div>

        {/* Scrollable Middle Content - File Tree */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Scrollable content */}
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<LoadingFallback />}>
              <FileExplorerSidebar
                cancelChildLoading={cancelChildLoading}
                currentFolderId={currentFolderId}
                filterError={filterErrorAsError}
                isInitialLoad={isInitialLoad}
                isLoading={isLoading}
                isLoadingForSelectAll={isLoadingForSelectAll}
                isLoadingForSelection={isLoadingForSelection}
                loadingFiles={loadingFiles}
                loadingPathForSelection={loadingPathForSelection}
                loadingPaths={loadingPaths}
                onLoadChildren={loadChildren}
                onSelectFolderRecursively={handleSelectFolderRecursively}
                quickFilteredTree={quickFilteredTree}
                rootDirectoryHandle={rootDirectoryHandle}
                treeError={error}
              />
            </Suspense>
          </div>
        </div>

        {/* Fixed Footer - Action buttons */}
        <div className="shrink-0 border-t bg-gradient-to-t from-muted/20 to-transparent">
          {/* Action buttons row */}
          <div className="@container/footer flex flex-wrap items-center justify-between gap-2 @[360px]:px-4 px-2 @[360px]:py-3 py-2">
            <ActionButtons
              addMultipleSelectedFiles={addMultipleSelectedFiles}
              addMultipleSelectedFilesChunked={addMultipleSelectedFilesChunked}
              cancelSelectAll={cancelSelectAll}
              currentFolderId={getRootFolderId(rootDirectoryHandle) ?? currentFolderId}
              displayedFiles={displayedFileList}
              encodeFileSelection={encodeFileSelection}
              filteredTree={quickFilteredTree ?? []}
              hasActiveQuickFilter={deferredQuickFilter.trim().length > 0}
              hasFilesInTree={fileTree.length > 0}
              isLoadingForSelectAll={isLoadingForSelectAll}
              maxSelectionCount={maxSelectionCount}
              selectAllRecursively={selectAllRecursively}
              selectedFiles={selectedFilesList}
              setSelectedFiles={setSelectedFilesFromList}
              visibleFilePaths={visibleFilePaths}
            />
            {/* Selection controls - mode toggle and count */}
            <div className="flex min-w-0 items-center gap-1.5">
              <SelectionModeBadge
                maxSelectionCount={maxSelectionCount}
                onMaxSelectionCountChange={handleMaxSelectionCountChange}
                onOpenRulesEditor={() => setIsRulesEditorOpen(true)}
                rulesEditorAvailable={true}
                show={!!rootDirectoryHandle}
                triggerVariant="icon"
              />
              <SelectionCounter
                compact
                maxSelectionCount={maxSelectionCount}
                selectedCount={selectedCount}
              />
            </div>
          </div>
        </div>

        {/* Selection Rules Editor Dialog */}
        <SelectionRulesEditor
          folderId={getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? ''}
          isOpen={isRulesEditorOpen}
          onOpenChange={setIsRulesEditorOpen}
        />

        {/* Restore Access Modal - shown when stored handles exist but need permission */}
        <RestoreAccessModal
          folderName={pendingRestore?.name ?? storedFolders[0]?.name ?? 'previous folder'}
          isOpen={!rootDirectoryHandle && (!!pendingRestore || showDeniedBanner || showStaleBanner)}
          isRestoring={isRestoring}
          onChooseDifferentFolder={handleChooseDifferentFolderFromRestore}
          onDismiss={dismissRestore}
          onRestore={() => {
            // CRITICAL: Chrome requires requestPermission() to be called as the ABSOLUTE
            // FIRST operation in the click handler. Even console.log can break gesture context.
            // See: https://developer.chrome.com/blog/user-activation
            const rawHandle = pendingRestore?.rawHandle;

            // Helper to complete restore after permission and hydration
            const completeRestore = (handle: FileSystemDirectoryHandle) => {
              // CRITICAL: Wait for Zustand store hydration before setting folder ID.
              // The store may not have loaded folderStates from localStorage yet.
              // If we call setCurrentFolderId before hydration, it won't find any
              // existing folder state and will create a new empty one instead.

              const doRestore = () => {
                const directoryHandle = {
                  path: handle.name,
                  name: handle.name,
                  kind: 'directory' as const,
                  platform: 'web' as const,
                  _internal: handle,
                };
                setRootDirectoryHandle(directoryHandle);
                // Note: setRootDirectoryHandle already calls setCurrentFolderId internally
                beginRestore()
                  .catch(() => {})
                  .finally(() => {
                    setIsRestoring(false);
                    setAccessLoading(false);
                  });
              };

              // Type guard to check if store has persist middleware using safe property access
              const hasPersistApi = (s: unknown): s is StoreWithPersist<unknown> => {
                if (typeof s !== 'function' || !('persist' in s)) {
                  return false;
                }
                const persistObj = (s as Record<string, unknown>)['persist'];
                if (typeof persistObj !== 'object' || persistObj === null) {
                  return false;
                }
                const persist = persistObj as Record<string, unknown>;
                return (
                  typeof persist['hasHydrated'] === 'function' &&
                  typeof persist['onFinishHydration'] === 'function'
                );
              };

              // Track subscription for cleanup if component unmounts during hydration
              let unsubscribeRef: (() => void) | null = null;
              let isCancelled = false;

              // Check if store has hydrated
              if (hasPersistApi(store)) {
                if (store.persist.hasHydrated()) {
                  doRestore();
                } else {
                  unsubscribeRef = store.persist.onFinishHydration(() => {
                    if (!isCancelled) {
                      unsubscribeRef?.();
                      unsubscribeRef = null;
                      doRestore();
                    }
                  });
                }
              } else {
                // No persist API available, proceed without waiting
                doRestore();
              }

              // Return cleanup function to prevent memory leaks
              // Note: This is captured in closure but the click handler is synchronous,
              // so we just need the flags for the hydration callback case
              return () => {
                isCancelled = true;
                unsubscribeRef?.();
              };
            };

            // If we have a raw handle, call requestPermission IMMEDIATELY - no other code first
            if (rawHandle && typeof rawHandle.requestPermission === 'function') {
              rawHandle.requestPermission({ mode: 'read' }).then(
                (permissionResult) => {
                  if (permissionResult === 'granted') {
                    setAccessLoading(true);
                    setIsRestoring(true);
                    completeRestore(rawHandle);
                  } else {
                    // Permission denied - use beginRestore to update UI state
                    setAccessLoading(true);
                    setIsRestoring(true);
                    beginRestore()
                      .then((restored) => {
                        if (restored) {
                          setRootDirectoryHandle(restored);
                        }
                      })
                      .catch(() => {})
                      .finally(() => {
                        setIsRestoring(false);
                        setAccessLoading(false);
                      });
                  }
                },
                (err) => {
                  logger.warn('requestPermission threw, falling back to legacy path', { err });
                  // Fall back to legacy path
                  setAccessLoading(true);
                  setIsRestoring(true);
                  beginRestore()
                    .then((restored) => {
                      if (restored) {
                        setRootDirectoryHandle(restored);
                      }
                    })
                    .catch(() => {})
                    .finally(() => {
                      setIsRestoring(false);
                      setAccessLoading(false);
                    });
                }
              );
              return;
            }

            // No raw handle - fall back to legacy async path
            setAccessLoading(true);
            setIsRestoring(true);
            beginRestore()
              .then((restored) => {
                if (restored) {
                  setRootDirectoryHandle(restored);
                }
              })
              .catch(() => {})
              .finally(() => {
                setIsRestoring(false);
                setAccessLoading(false);
              });
          }}
          variant={showStaleBanner ? 'stale' : showDeniedBanner ? 'denied' : 'pending'}
        />
      </div>
    </FileExplorerErrorBoundary>
  );
});

FileExplorerPanel.displayName = 'FileExplorerPanel';
