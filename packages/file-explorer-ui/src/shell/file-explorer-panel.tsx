/// <reference path="../types/window.d.ts" />
import type { AnyContextAction } from '@brainstrike/context-actions';
import {
  countSelectedInDirectory,
  encodeFileSelection,
} from '@brainstrike/file-explorer/selection';
import { useAdapters, useToastManager } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import { cn, LoadingFallback, SELECTION_BAR_SCROLL_PADDING } from '@brainstrike/ui';
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
import { shallow } from 'zustand/shallow';
import ActionButtons from '../action-buttons-array-facade';
import { ExpandAllConfirmDialog } from '../components/expand-all-confirm-dialog';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { FilterStatus } from '../file-explorer-status-components';
import { useExplorerScrollRestore } from '../hooks/use-explorer-scroll-restore';
import { useExplorerRowMetadata } from '../indexing/file-row-metadata-context';
import { FileRowMetadataProvider } from '../indexing/file-row-metadata-provider';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';
import { RestorationStatus } from '../restoration-status';
import { formatCompactSelectionCount } from '../selection-count-format';
import { SelectionCounter } from '../selection-counter';
import { SelectionModeBadge } from '../selection-mode-badge';
import { ToolbarPresetSelector } from '../toolbar-preset-selector';
import { getRootFolderId } from '../utils/get-root-folder-id';
import { applyQuickFilterToTree, collectVisibleFiles } from '../utils/quick-filter-tree';
import { ExplorerColumnVisibilityControls } from './explorer-column-visibility-controls';
import { useExplorerColumnsValue } from './explorer-columns-context';
import { ExplorerColumnsProvider } from './explorer-columns-provider';
import { ExplorerSortProvider } from './explorer-sort-provider';
import {
  CompactToolbarActions,
  FilterChipsToggleButton,
  PanelTreeActionButtons,
  PanelTreeExpansionButtons,
  ViewFiltersToggleButton,
} from './file-explorer-panel-toolbar-helpers';
import {
  isCancellableOperationRunning,
  isForestModeActive,
  resolveCompactToolbarActionsState,
  resolveSelectAllWiring,
  runFocusedTreeExpandAll,
  runForestSelectAllSweep,
} from './file-explorer-panel-toolbar-logic';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { createFileExplorerRefreshEvent } from './file-explorer-refresh-event';
import { FileExplorerSelectionActions } from './file-explorer-selection-actions';
import FileExplorerSidebar from './file-explorer-sidebar';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { FileFilterBar } from './file-filter-bar';
import {
  useForestIsExpandingAll,
  useOptionalForestTreeActions,
} from './forest-tree-actions-context';
import { ForestTreeActionsProvider } from './forest-tree-actions-provider';
import { useFileExplorer } from './use-file-explorer-context';
import { useForestExpandConfirm } from './use-forest-expand-confirm';
import { useSelectionManager } from './use-selection-manager-context';

const logger = createLogger('FileExplorerPanel');

const EMPTY_DISPLAYED_FILE_LIST: string[] = [];

function collectVisibleFilePathsIfNeeded(
  tree: IFileNode[] | null,
  shouldCollect: boolean
): string[] {
  if (!(shouldCollect && tree)) {
    return EMPTY_DISPLAYED_FILE_LIST;
  }
  const visible = new Set<string>();
  collectVisibleFiles(tree, visible);
  return Array.from(visible);
}

function shouldCollectVisibleFilePaths(
  hasRecursiveSelectAll: boolean,
  quickFilter: string,
  hasQuickFilterSelectAllOverride: boolean
): boolean {
  return (
    !hasRecursiveSelectAll || (quickFilter.trim().length > 0 && !hasQuickFilterSelectAllOverride)
  );
}

function hasForestQuickFilterSelectAllOverride(
  isForestMode: boolean,
  forestActions: ReturnType<typeof useOptionalForestTreeActions>
): boolean {
  return isForestMode && forestActions !== null;
}

/** The selection bar is up whenever there is a selection, and then needs the padding. */
function explorerScrollRootClassName(selectedCount: number): string {
  return cn('h-full overflow-y-auto', selectedCount > 0 && SELECTION_BAR_SCROLL_PADDING);
}

const LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD = 250;

/**
 * Owns the tree area's measured width, the one column input that changes on
 * every pointer move of a panel drag (BST-2184). Held here rather than in the
 * panel, a width change re-renders only this provider: `children` are elements
 * the panel already created, so React skips them, and only the
 * `useExplorerColumns` consumers re-render, and only when the resolved columns
 * actually change.
 */
function MeasuredExplorerColumnsProvider({
  children,
  containerRef,
}: {
  children: React.ReactNode;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <ExplorerColumnsProvider value={useExplorerColumnsValue(containerRef)}>
      {children}
    </ExplorerColumnsProvider>
  );
}

export interface FileExplorerPanelProps {
  /**
   * Host-composed `workspace-root` context actions (Open in Terminal, New
   * thread here). Injected for the same reason `selectionActions` is: they
   * close over app-shell seams this package must not depend on.
   */
  readonly rootActions?: readonly AnyContextAction[] | undefined;
  /**
   * Host-composed controls for the ephemeral selection bar (see
   * `FileExplorerSelectionActions`). Kept as an injected node so the shell can
   * contribute actions (attach to thread, context export) without this package
   * depending on it back.
   */
  readonly selectionActions?: React.ReactNode | undefined;
}

/**
 * FileExplorerPanel - Contains the file tree and toolbar
 * This component can be used independently in a panel of an IDE layout
 */
const FileExplorerPanelInner = React.memo((props: FileExplorerPanelProps) => {
  const { rootActions, selectionActions } = props;
  const { fileSystemAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  // Persist + restore the explorer scroll position across sessions. Wired to the
  // outer scroll root; the hook resolves the active (single-root vs forest)
  // scroller and captures via a capture-phase listener.
  const explorerScrollRootRef = React.useRef<HTMLDivElement | null>(null);
  // Tree-grid columns: persisted preference narrowed by the tree area's width,
  // measured by `MeasuredExplorerColumnsProvider` so a resize skips this panel.
  const treeAreaRef = React.useRef<HTMLDivElement | null>(null);
  useExplorerScrollRestore(explorerScrollRootRef);
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
    isFilterChipsVisible,
    setFilterChipsVisible,
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
        s.isFilterChipsVisible,
        s.setFilterChipsVisible,
      ] as const,
    shallow
  );

  const handleMaxSelectionCountChange = (count: number) => {
    setMaxSelectionCount(count);
  };

  // Local state for UI
  const [isRefreshing, setIsRefreshing] = useState(false);
  const previousRootFolderIdRef = useRef<string | null>(null);
  const restorationLimitNoticeKeyRef = useRef<string | null>(null);

  const {
    fileTree,
    handleRootDirectorySelect,
    isLoading,
    error,
    loadingFiles,
    filterError,
    rootDirectoryHandle,
    rootDirectoryHandles,
    isFileSystemAccessSupported,
    refreshFileExplorer,
    isInitialLoad,
    loadingProgress,
    cancellable,
    cancelOperation,
    isCancelling,
    clearRootDirectory: _clearRootDirectory,
    loadingPaths,
    loadChildren,
    cancelChildLoading,
    expandAllProgressively,
    cancelExpandAll,
    isExpandingAll,
    expandAllProgress,
    isRestoringExpandedPaths,
    restorationProgress,
    selectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll,
    addRootDirectory,
    removeRootDirectory,
    setFocusedRoot,
    rootIdByPath,
    unfilteredFileTree,
  } = useFileExplorer();

  const {
    showToast,
    handleRefreshError,
    handleBrowserCompatibilityError,
    handleDirectorySelectError,
  } = useToastManager();

  useEffect(() => {
    const omittedPathCount = restorationProgress?.omitted ?? 0;
    if (omittedPathCount <= 0) {
      return;
    }

    const noticeKey = `${rootDirectoryHandle?.path ?? 'workspace'}:${omittedPathCount}`;
    if (restorationLimitNoticeKeyRef.current === noticeKey) {
      return;
    }
    restorationLimitNoticeKeyRef.current = noticeKey;
    showToast({
      description: `${omittedPathCount.toLocaleString()} previously expanded folders were kept collapsed. Restore is limited to ${restorationProgress?.total ?? 0} folders per root so the app remains responsive.`,
      title: 'Large folder restore limited',
    });
  }, [
    restorationProgress?.omitted,
    restorationProgress?.total,
    rootDirectoryHandle?.path,
    showToast,
  ]);

  // MAIN root = activeRootIds[0] (the assistant's operating root). Threaded
  // to the sidebar so forest sections can badge it; distinct from the
  // FOCUSED root (currentFolderId) above.
  const mainRootId = useFileExplorerStoreSelector((s) => s.activeRootIds?.[0]);
  // Get store actions for recursive folder selection
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const addMultipleSelectedFilesChunked = useFileExplorerStoreSelector(
    (s) => s.addMultipleSelectedFilesChunked
  );
  const { selectedCount, selectedFilePaths, selectedFilesList, setSelectedFilesFromList } =
    useSelectionManager();

  // Wrapper for recursive folder selection that binds store actions
  // This allows FileExplorerSidebar to call with just the node
  const handleSelectFolderRecursively = async (node: IFileNode) => {
    // The node carries its OWN root identity (stamped by every tree loader
    // since storage v5) — the focused root's id is WRONG for clicks inside
    // another root's tree in forest mode. Focused-root resolution remains
    // only as the fallback for legacy nodes without a rootFolderId.
    const folderId =
      node.rootFolderId ||
      (getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? currentFolderId ?? '');
    const selectedDescendantCount = countSelectedInDirectory(
      selectedFilesList,
      folderId,
      node.path
    );
    return selectFolderRecursively(
      node,
      folderId,
      addMultipleSelectedFiles,
      maxSelectionCount,
      selectedCount,
      selectedDescendantCount,
      addMultipleSelectedFilesChunked
    );
  };

  // Convert string filterError to Error object for compatibility with FileExplorerSidebar
  const filterErrorAsError = useMemo(() => {
    if (!filterError) {
      return null;
    }
    return new Error(filterError);
  }, [filterError]);

  const stableFileTree = fileTree || [];

  // Get selection model for query-mode token counting and display
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);

  const largeSelectionDiagnosticSignatureRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (
      !(window as Window & { desktopLifecycle?: { isTestMode?: boolean } }).desktopLifecycle
        ?.isTestMode
    ) {
      return;
    }

    window.__brainstrikeFileExplorerTestHooks__ = {
      getSnapshot: () => ({
        currentFolderId,
        materializedPathCount: selectionModel.materializedPaths?.size ?? 0,
        materializedPathSamples: Array.from(selectionModel.materializedPaths ?? []).slice(0, 5),
        rootDirectoryPath: rootDirectoryHandle?.path ?? null,
        selectedFilePathCount: selectedFilePaths.size,
        selectedFilePathSamples: Array.from(selectedFilePaths).slice(0, 5),
        selectionMode: selectionModel.mode,
        treeRootCount: stableFileTree.length,
        treeSamples: stableFileTree.slice(0, 5).map((node) => ({
          childCount: node.children?.length ?? 0,
          path: node.path,
          rootFolderId: node.rootFolderId ?? null,
          type: node.type,
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
  const electronFileReader = async (handle: {
    path: string;
    name: string;
    kind: 'file';
    platform: 'electron';
  }) => fileSystemAdapter.readFile(handle);

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
  const quickFilteredTree = stableFileTree
    ? applyQuickFilterToTree(stableFileTree, deferredQuickFilter)
    : null;

  // Per-row metadata seam (BST-1207/1208). Owned here because `onTokenResolved`
  // below is the PRECISE invalidation path: every count the indexer resolves
  // repaints exactly that row's cell. Without this wiring the tree grid still
  // fills in — through the 250ms bulk reconcile — which is why dropping it is
  // silent, and why the panel test pins it.
  //
  // `visibleFileKeys` is the background indexer's second (visible/expanded)
  // trigger — BST-1207 decision D2. It comes from the seam rather than from
  // this component's own tree because `useFileExplorer()` only ever sees the
  // FOCUSED root: deriving it here left every other forest section unindexed
  // (whole-branch review F2). Each mounted tree publishes its own display
  // enumeration and the registry merges them, keeping the snapshot CONTENT-
  // stable so an unchanged republication does not re-arm the indexing debounce.
  const rowMetadata = useExplorerRowMetadata();

  // This hook automatically indexes selected AND visible files when a
  // TokenCacheProvider is present.
  useBackgroundTokenIndexerIntegration({
    electronFileReader,
    fileTree: stableFileTree,
    onTokenResolved: rowMetadata.onTokenResolved,
    selectedFiles: selectedFilePaths,
    visibleFiles: rowMetadata.visibleFileKeys,
  });

  // Forest sections own their tree enumeration and provide the quick-filter
  // Select All override through this registry. Resolve that capability before
  // deciding whether the focused panel must materialize a fallback path list.
  const forestActions = useOptionalForestTreeActions();
  const isForestMode = isForestModeActive(rootDirectoryHandles);
  const hasQuickFilterSelectAllOverride = hasForestQuickFilterSelectAllOverride(
    isForestMode,
    forestActions
  );

  // displayedFiles are only needed by the legacy "fallback select-all" path.
  // In desktop, recursive select-all should always be available and this stays false.
  // Keep a runtime capability check so tests and non-desktop adapters can still exercise fallback.
  const hasRecursiveSelectAll =
    typeof (selectAllRecursively as unknown) === 'function' &&
    typeof (addMultipleSelectedFiles as unknown) === 'function';
  const useFallbackDisplayedFiles = !hasRecursiveSelectAll;

  // Recursive select-all does not need a materialized path list. Quick-filter
  // selection still does because it intentionally selects only displayed
  // matches, so retain the walk for that explicit path and for legacy adapters.
  const needsVisibleFilePaths = shouldCollectVisibleFilePaths(
    hasRecursiveSelectAll,
    deferredQuickFilter,
    hasQuickFilterSelectAllOverride
  );
  const visibleFilePaths = useMemo(
    () => collectVisibleFilePathsIfNeeded(quickFilteredTree, needsVisibleFilePaths),
    [needsVisibleFilePaths, quickFilteredTree]
  );

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
      currentFolderId,
      expandAllInProgress: isExpandingAll,
      fallbackDisplayedFileCount: useFallbackDisplayedFiles ? displayedFileList.length : null,
      isLoading,
      isLoadingForSelectAll,
      isLoadingForSelection,
      isQuickFiltering,
      loadingPathCount: loadingPaths.size,
      materializedPathCount,
      quickFilteredTreeRootCount: quickFilteredTree?.length ?? 0,
      selectedCount,
      selectedFilePathsCount: selectedFilePaths.size,
      selectionMode: selectionModel.mode,
      treeRootCount,
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

  const handleRefresh = async () => {
    if (!rootDirectoryHandle) {
      return;
    }

    setIsRefreshing(true);
    try {
      const refreshResult = await refreshFileExplorer();
      if (refreshResult.status === 'cancelled') {
        setIsRefreshing(false);
        return;
      }
      // Dispatch only after a SUCCESSFUL refresh (cancelled/failed refreshes
      // must not trigger downstream full syncs — pinned by the panel tests).
      // The outer provider ignores this event (skipManualFullEvents — it was
      // just refreshed above); forest RootSection providers react to it.
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [],
          scope: 'full',
          source: 'manual',
        })
      );
      showToast({
        description: FileExplorerStrings.success.refreshSuccess,
        title: FileExplorerStrings.success.title,
      });
    } catch (error) {
      handleRefreshError(error);
    }
    setIsRefreshing(false);
  };

  const handleDirectorySelect = async () => {
    const { supported, reason } = isFileSystemAccessSupported();
    if (!supported) {
      // Fall back to inline fixture demo mode when the directory picker is unavailable.
      // Check for loadInlineFixture to detect a fixture-capable adapter without importing
      // from @brainstrike/file-system (avoids circular dep in this package boundary).
      const adapterAsFixture = fileSystemAdapter as { loadInlineFixture?: unknown };
      if (typeof adapterAsFixture.loadInlineFixture === 'function') {
        setDevInlineFixtureEnabled(true);
        showToast({
          description: FileExplorerStrings.inlineFixture.noAccessFallbackDescription,
          title: FileExplorerStrings.inlineFixture.noAccessFallbackTitle,
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
  };

  const handleToolbarDirectorySelect = async (): Promise<void> => {
    // When roots already exist, use addRootDirectory (multi-root Add Folder).
    // Otherwise fall back to the standard single-root select flow.
    const hasRoots = (rootDirectoryHandles?.length ?? 0) > 0;
    if (hasRoots && addRootDirectory) {
      try {
        await addRootDirectory();
      } catch (error) {
        handleDirectorySelectError(error);
      }
      return;
    }
    await handleDirectorySelect();
  };

  const handleFilterChange = (
    newIncludeFilters: string[],
    newExcludeFilters: string[],
    newUseRegex: boolean
  ) => {
    // Avoid forcing a synchronous full-tree filter pass on preset changes.
    // We only update filter state here; deferred filtering happens in useFileExplorer().
    setFilters(newIncludeFilters, newExcludeFilters);
    setUseRegex(newUseRegex);
  };

  useEffect(() => {
    if (rootDirectoryHandle) {
      // Storage v5: resolve the durable RootId UUID via rootIdByPath. The
      // one-arg form would return handle.path and clobber the UUID identity
      // in the store (wiping the keyed folder state via buildResetState).
      const id = getRootFolderId(rootDirectoryHandle, rootIdByPath);
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
      // Calling setCurrentFolderId(null) triggers buildResetState(), which clears
      // expandedDirectoryPaths, so a persisted folder state is kept for its root.
      const hasRecoverablePersistedFolder =
        currentFolderId !== null && Boolean(store.getState().folderStates[currentFolderId]);
      if (!hasRecoverablePersistedFolder) {
        setCurrentFolderId(null);
      }
    }
  }, [
    rootDirectoryHandle,
    // rootIdByPath gets a new Map identity on each root registration; the
    // effect body is idempotent when the resolved id is stable, so the extra
    // re-fires are safe.
    rootIdByPath,
    setCurrentFolderId,
    hydrateFolderState,
    store,
  ]);

  // Forest mode: Expand All must run inside EACH root section's own tree
  // context — the legacy path below only expands the focused provider's
  // (invisible) top-level tree when multiple roots are active.
  // Single source for the forest cancel: the toolbar cluster and the
  // compact-menu yield rule must agree on whether one exists, or the menu could
  // stand down for an operation that renders no cancel.
  const forestCancelExpandAll = forestActions?.cancelExpandAll ?? null;
  // Run-boundary signal only — high-frequency progress is subscribed by the
  // PanelTreeActionButtons leaf, never by this panel component.
  const isForestExpandingAll = useForestIsExpandingAll();
  /**
   * "An expand-all sweep is running SOMEWHERE" — a forest sweep runs inside the
   * section providers, so the focused provider's flag stays false throughout.
   * Derived once: the toolbar buttons, the compact menu and the run guard must
   * agree, and repeating the disjunction was also what tipped this component
   * over the cognitive-complexity cap.
   */
  const isAnyExpandAllRunning = isExpandingAll || isForestExpandingAll;

  const forestExpandConfirm = useForestExpandConfirm(forestActions);
  const stageForestExpandConfirm = forestExpandConfirm.stage;

  const expandAll = useCallback(() => {
    logger.info('expandAll clicked', {
      fileTreeLength: fileTree?.length ?? 0,
      hasFileTree: !!fileTree,
      isExpandingAll,
      isForestMode,
    });

    // Prevent clicks while expand-all is already running
    if (isAnyExpandAllRunning) {
      logger.info('expandAll: blocked - already expanding');
      return;
    }

    if (isForestMode && forestActions) {
      stageForestExpandConfirm();
      return;
    }

    runFocusedTreeExpandAll(store, expandAllProgressively, fileTree);
  }, [
    fileTree,
    forestActions,
    isAnyExpandAllRunning,
    isForestMode,
    stageForestExpandConfirm,
    store,
    expandAllProgressively,
    isExpandingAll,
  ]);

  const collapseAll = () => {
    // Cancel any in-progress expand-all first (every section + the legacy path),
    // then clear the workspace-global expansion set — all sections collapse.
    forestActions?.cancelExpandAll();
    cancelExpandAll();
    store.getState().collapseAllDirectories();
    // Forest mode: one click means FULLY compact — the root section headers
    // close too, not just the directories under them (BST-571).
    forestActions?.collapseAllSections();
  };

  const forestSelectAll: typeof selectAllRecursively = (
    _filteredTree,
    _folderId,
    _addFiles,
    maxCount
  ) => runForestSelectAllSweep({ forestActions, maxCount, showToast });
  // FOREST quick-filter Select All: select the visible search matches across
  // EVERY section (composite keys through the union-partitioning setter) —
  // no scanning beyond what the user sees, capped at the selection limit.
  const forestQuickFilterSelectAll = () => {
    const keys = (forestActions?.collectVisibleQuickFilterKeys() ?? []).slice(0, maxSelectionCount);
    if (keys.length === 0) {
      showToast({
        description: 'No visible files match the quick filter in any folder.',
        title: 'No files match the search',
      });
      return;
    }
    setSelectedFilesFromList(keys);
  };
  const selectAllWiring = resolveSelectAllWiring({
    fileTreeLength: fileTree.length,
    forestActions,
    forestQuickFilterSelectAll,
    forestSelectAll,
    isForestMode,
    selectAllRecursively,
  });

  // Routing through the list setter (rather than the raw store setter) keeps
  // the cross-root partition semantics: every active root's folderState is
  // cleared too, not just the focused root's top-level set.
  const handleClearSelection = () => {
    setSelectedFilesFromList([]);
  };

  const handleCancelOperation = () => {
    cancelOperation();
    showToast({
      description: 'The file loading operation has been cancelled.',
      title: 'Operation Cancelled',
      variant: 'default',
    });
  };

  return (
    <FileExplorerErrorBoundary>
      <MeasuredExplorerColumnsProvider containerRef={treeAreaRef}>
        <div className="grid h-full min-w-0 grid-rows-[auto_1fr] overflow-hidden">
          {/* Fixed Header - Toolbar and filter controls */}
          <div className="min-w-0 shrink-0">
            <FileExplorerToolbar
              bulkSelectionControl={
                <ActionButtons
                  addMultipleSelectedFiles={addMultipleSelectedFiles}
                  addMultipleSelectedFilesChunked={addMultipleSelectedFilesChunked}
                  cancelSelectAll={cancelSelectAll}
                  currentFolderId={
                    getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? currentFolderId
                  }
                  displayedFiles={displayedFileList}
                  encodeFileSelection={encodeFileSelection}
                  filteredTree={quickFilteredTree ?? []}
                  hasActiveQuickFilter={deferredQuickFilter.trim().length > 0}
                  hasFilesInTree={selectAllWiring.hasFilesInTree}
                  isLoadingForSelectAll={isLoadingForSelectAll}
                  maxSelectionCount={maxSelectionCount}
                  quickFilterSelectAllOverride={selectAllWiring.quickFilterSelectAllOverride}
                  selectAllRecursively={selectAllWiring.selectAll}
                  selectedFiles={selectedFilesList}
                  setSelectedFiles={setSelectedFilesFromList}
                  visibleFilePaths={visibleFilePaths}
                />
              }
              columnsControl={
                <ExplorerColumnVisibilityControls show={Boolean(rootDirectoryHandle)} />
              }
              compactActionsControl={
                <CompactToolbarActions
                  onCollapseAll={collapseAll}
                  onExpandAll={expandAll}
                  onRefresh={handleRefresh}
                  setFiltersExpanded={setFiltersExpanded}
                  state={resolveCompactToolbarActionsState({
                    hasRoot: Boolean(rootDirectoryHandle),
                    isExpandingAll: isAnyExpandAllRunning,
                    isFiltersExpanded,
                    isLoading,
                    isOperationInProgress: isCancellableOperationRunning({
                      forestCancelExpandAll,
                      isExpandingAll,
                      isForestExpandingAll,
                      loadingProgress,
                    }),
                    isRefreshing,
                  })}
                />
              }
              filtersControl={
                rootDirectoryHandle ? (
                  <ViewFiltersToggleButton
                    hasHiddenActiveFilter={!isFiltersExpanded && quickFilter.trim().length > 0}
                    isFiltersExpanded={isFiltersExpanded}
                    setFiltersExpanded={setFiltersExpanded}
                  />
                ) : null
              }
              isLoading={isLoading}
              onDirectorySelect={handleToolbarDirectorySelect}
              selectionStatusControl={
                <div
                  // overflow-hidden is STRUCTURAL, not cosmetic: this cluster
                  // is `min-w-0`, so a shrunk box lets its content spill to the
                  // right and PAINT OVER the Expand/Collapse cluster beside it
                  // — measured live at a 349px panel, the counter covered the
                  // left half of Expand All and swallowed its clicks. Clipping
                  // makes that a visual truncation instead of a dead control.
                  className="flex min-w-0 items-center gap-0.5 overflow-hidden @[128px]:gap-1.5"
                  data-testid="selection-status-controls"
                >
                  <SelectionModeBadge
                    compactValue={{
                      accessibleLabel: `${selectedCount} of ${maxSelectionCount} files selected.`,
                      label: formatCompactSelectionCount(selectedCount),
                    }}
                    maxSelectionCount={maxSelectionCount}
                    onMaxSelectionCountChange={handleMaxSelectionCountChange}
                    show={!!rootDirectoryHandle}
                    triggerVariant="icon"
                  />
                  {/* Yields ONLY where it actually competes.
                      The Expand/Collapse cluster shares this track, but only
                      from the toolbar's 236px step — below that the pair is in
                      the compact menu and nothing is competing, so the counter
                      stays. MEASURED on the built preview: the left track needs
                      180px to hold pl-3 (12) + this cluster's 106px of content
                      + the 4px gap + the 58px expansion pair, and the track is
                      (toolbarWidth - 28) / 2, so 180px of track is a 388px
                      toolbar. Hence exactly one hidden band, 236px..388px.
                      Gated on the TOOLBAR container because both edges of that
                      band are toolbar widths. */}
                  <div
                    className="hidden @max-[236px]/explorer-toolbar:block @[388px]/explorer-toolbar:block"
                    data-testid="selection-counter-control"
                  >
                    <SelectionCounter
                      compact
                      maxSelectionCount={maxSelectionCount}
                      selectedCount={selectedCount}
                    />
                  </div>
                </div>
              }
              treeActionsControl={
                rootDirectoryHandle ? (
                  <PanelTreeActionButtons
                    cancelExpandAll={cancelExpandAll}
                    cancellable={cancellable}
                    expandAllProgress={expandAllProgress}
                    forestCancelExpandAll={forestCancelExpandAll}
                    handleCancelOperation={handleCancelOperation}
                    isCancelling={isCancelling}
                    isExpandingAll={isExpandingAll}
                    isForestExpandingAll={isForestExpandingAll}
                    isLoading={isLoading}
                    isRefreshing={isRefreshing}
                    loadingProgress={loadingProgress}
                    onRefresh={handleRefresh}
                  />
                ) : null
              }
              treeExpansionControl={
                <PanelTreeExpansionButtons
                  hasRoot={Boolean(rootDirectoryHandle)}
                  isExpandingAll={isAnyExpandAllRunning}
                  isLoading={isLoading}
                  isRefreshing={isRefreshing}
                  onCollapseAll={collapseAll}
                  onExpandAll={expandAll}
                />
              }
            />
            {/* Filter section: one toggled block (driven from the toolbar's
                view-filters button) hosting the preset row, the filter chips, and
                the quick-filter row. grid-rows 0fr->1fr animates to natural
                content height (unlike a max-height cap, which clips when many
                filter chips wrap). It does not wait for a root: an open block
                that mounted only once the restored root arrived pushed the
                tree down at startup. */}
            <div
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                isFiltersExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              )}
              id="view-filters-content"
              inert={!isFiltersExpanded}
            >
              <div className="overflow-hidden">
                <div className="space-y-2 border-b px-2 py-2">
                  <div className="flex items-center gap-1.5">
                    <ToolbarPresetSelector
                      className="h-8 min-w-0 flex-1 @[300px]:h-9"
                      onFilterChange={handleFilterChange}
                    />
                    <FilterChipsToggleButton
                      isFilterChipsVisible={isFilterChipsVisible}
                      setFilterChipsVisible={setFilterChipsVisible}
                    />
                  </div>
                  {/* Filter chips - independently collapsible to reclaim vertical
                        space. Same grid-rows technique as the section collapse so
                        toggling animates to natural height without clipping. */}
                  <div
                    className={cn(
                      'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                      isFilterChipsVisible
                        ? 'grid-rows-[1fr] opacity-100'
                        : 'grid-rows-[0fr] opacity-0'
                    )}
                    inert={!isFilterChipsVisible}
                  >
                    <div className="overflow-hidden">
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
                  {/* Quick filter input. The tree action buttons live on the
                        toolbar so they stay reachable while this block is
                        collapsed. */}
                  <FileFilterBar
                    isFiltering={isQuickFiltering}
                    onChange={setQuickFilter}
                    onClear={clearQuickFilter}
                    value={quickFilter}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Scrollable Middle Content - File Tree */}
          <div className="relative min-h-0 flex-1 overflow-hidden" ref={treeAreaRef}>
            {/* Restoration indicator - floats above the tree as an overlay so
                mounting/unmounting never shifts the tree rows below it. It
                stacks above the grid's sticky column header (z-10), which
                otherwise paints over it. */}
            <div className="pointer-events-none absolute inset-x-2 top-2 z-20">
              <RestorationStatus
                isRestoring={isRestoringExpandedPaths}
                progress={restorationProgress}
              />
            </div>
            {/* Expand/Collapse All are NOT here any more. They floated over
                this corner (BST-571) until BST-1208 put the tree grid's column
                header in it — the overlay covered the trailing header cell and
                swallowed its clicks. They now live in the toolbar's left track
                (whole-branch review F11). */}
            {/* Scrollable content — scroll root for session scroll restore.
                While the selection bar floats above, the scroll owner keeps
                matching bottom padding so the last rows stay reachable; the bar
                itself never enters normal flow, so rows never shift. */}
            <div
              className={explorerScrollRootClassName(selectedCount)}
              data-testid="explorer-scroll-root"
              ref={explorerScrollRootRef}
            >
              <Suspense fallback={<LoadingFallback />}>
                <FileRowMetadataProvider value={rowMetadata.contextValue}>
                  <FileExplorerSidebar
                    cancelChildLoading={cancelChildLoading}
                    currentFolderId={currentFolderId}
                    filterError={filterErrorAsError}
                    isDisplayTreeFiltered={quickFilteredTree !== unfilteredFileTree}
                    isInitialLoad={isInitialLoad}
                    isLoading={isLoading}
                    isLoadingForSelectAll={isLoadingForSelectAll}
                    isLoadingForSelection={isLoadingForSelection}
                    loadingFiles={loadingFiles}
                    loadingPathForSelection={loadingPathForSelection}
                    loadingPaths={loadingPaths}
                    mainRootId={mainRootId}
                    onLoadChildren={loadChildren}
                    onRemoveRoot={removeRootDirectory}
                    onSelectFolderRecursively={handleSelectFolderRecursively}
                    quickFilteredTree={quickFilteredTree}
                    rootActions={rootActions}
                    rootDirectoryHandle={rootDirectoryHandle}
                    rootDirectoryHandles={rootDirectoryHandles}
                    rootIdByPath={rootIdByPath}
                    setFocusedRoot={setFocusedRoot}
                    treeError={error}
                  />
                </FileRowMetadataProvider>
              </Suspense>
            </div>
            {/* Ephemeral selection actions. Same overlay contract as the
                indicators above: it floats, so it never shifts tree rows. */}
            <FileExplorerSelectionActions
              onClear={handleClearSelection}
              selectedCount={selectedCount}
              trailingContent={selectionActions}
            />
          </div>

          {/* Forest Expand All confirmation - multi-root sweeps are staged */}
          <ExpandAllConfirmDialog
            onCancel={forestExpandConfirm.dismiss}
            onConfirm={forestExpandConfirm.confirm}
            open={forestExpandConfirm.isOpen}
            rootCount={rootDirectoryHandles.length}
          />
        </div>
      </MeasuredExplorerColumnsProvider>
    </FileExplorerErrorBoundary>
  );
});

FileExplorerPanelInner.displayName = 'FileExplorerPanelInner';

/**
 * Public panel: wraps the inner panel with the forest tree-actions registry
 * so toolbar Expand All / Collapse All can drive every root section's own
 * tree context (the inner panel and the sidebar sections both consume it).
 */
export const FileExplorerPanel = ({
  rootActions,
  selectionActions,
}: FileExplorerPanelProps = {}) => (
  <ExplorerSortProvider>
    <ForestTreeActionsProvider>
      <FileExplorerPanelInner rootActions={rootActions} selectionActions={selectionActions} />
    </ForestTreeActionsProvider>
  </ExplorerSortProvider>
);

FileExplorerPanel.displayName = 'FileExplorerPanel';
