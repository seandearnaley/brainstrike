import { useAdapters, useRestoreAccess, useToastManager } from '@brainstrike/file-explorer-hooks';
import { FileExplorerStrings, type IFileNode } from '@brainstrike/types';
import {
  Button,
  cn,
  LoadingFallback,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { Eye, EyeOff, SlidersHorizontal } from 'lucide-react';
import type { StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { UseBoundStoreWithEqualityFn } from 'zustand/traditional';

const logger = createLogger('FileExplorerPanel');

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
import { ExpandAllConfirmDialog } from '../components/expand-all-confirm-dialog';
import { FloatingTreeActions } from '../components/floating-tree-actions';
import { RestoreAccessModal } from '../components/restore-access-modal';
import { TreeActionButtons } from '../components/tree-action-buttons';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';
import { FilterStatus } from '../file-explorer-status-components';
import { useExplorerScrollRestore } from '../hooks/use-explorer-scroll-restore';
import { useBackgroundTokenIndexerIntegration } from '../indexing/use-background-token-indexer-integration';
import { RestorationStatus } from '../restoration-status';
import { formatCompactSelectionCount } from '../selection-count-format';
import { SelectionCounter } from '../selection-counter';
import { SelectionModeBadge } from '../selection-mode-badge';
import { ToolbarPresetSelector } from '../toolbar-preset-selector';
import { getRootFolderId } from '../utils/get-root-folder-id';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';
import { applyQuickFilterToTree, collectVisibleFiles } from '../utils/quick-filter-tree';
import { computeScanningStatusProps } from '../utils/scanning-status-props';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { createFileExplorerRefreshEvent } from './file-explorer-refresh-event';
import FileExplorerSidebar from './file-explorer-sidebar';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { FileFilterBar } from './file-filter-bar';
import {
  type ExpandAllProgress,
  ForestTreeActionsProvider,
  type ForestTreeActionsValue,
  useForestExpandAllProgress,
  useForestIsExpandingAll,
  useOptionalForestTreeActions,
} from './forest-tree-actions-context';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectionManager } from './use-selection-manager-context';

const EMPTY_DISPLAYED_FILE_LIST: string[] = [];
const LARGE_SELECTION_RENDER_DIAGNOSTIC_THRESHOLD = 250;

/** Eye toggle for the filter-chips row (from #1192), extracted for the complexity cap. */
function FilterChipsToggleButton({
  isFilterChipsVisible,
  setFilterChipsVisible,
}: {
  isFilterChipsVisible: boolean;
  setFilterChipsVisible: (visible: boolean) => void;
}) {
  const label = isFilterChipsVisible ? 'Hide filter chips' : 'Show filter chips';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={isFilterChipsVisible}
          className="@[300px]:h-9 h-8 @[300px]:w-9 w-8 shrink-0"
          data-testid="toggle-filter-chips-button"
          onClick={() => setFilterChipsVisible(!isFilterChipsVisible)}
          size="icon"
          variant="ghost"
        >
          {isFilterChipsVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Toolbar toggle for the whole view-filters block (presets, chips, quick filter). */
function ViewFiltersToggleButton({
  hasHiddenActiveFilter,
  isFiltersExpanded,
  setFiltersExpanded,
}: {
  /** True when a quick filter is still narrowing the tree while the block is collapsed. */
  hasHiddenActiveFilter: boolean;
  isFiltersExpanded: boolean;
  setFiltersExpanded: (expanded: boolean) => void;
}) {
  const label = isFiltersExpanded
    ? 'Hide view filters'
    : `Show view filters${hasHiddenActiveFilter ? ' (quick filter active)' : ''}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-controls="view-filters-content"
          aria-expanded={isFiltersExpanded}
          aria-label={label}
          className={cn(
            'relative @[96px]/explorer-toolbar:size-7 size-6 shrink-0 p-0',
            isFiltersExpanded && 'bg-muted text-foreground'
          )}
          data-testid="toggle-view-filters-button"
          onClick={() => setFiltersExpanded(!isFiltersExpanded)}
          size="icon"
          variant="ghost"
        >
          <SlidersHorizontal className="size-4" />
          {hasHiddenActiveFilter ? (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
              data-testid="view-filters-active-indicator"
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** Forest mode = more than one active root (sections render per root). */
function isForestModeActive(rootDirectoryHandles: readonly unknown[] | undefined): boolean {
  return (rootDirectoryHandles?.length ?? 0) > 1;
}

/**
 * Toolbar scanning-indicator source for expand-all: during a forest sweep the
 * focused provider's isExpandingAll/expandAllProgress stay idle (each section
 * expands inside its OWN provider), so progress and cancel must come from the
 * forest registry's aggregate instead.
 */
function resolveExpandAllScanningSource(args: {
  cancelExpandAll: () => void;
  expandAllProgress: { loaded: number; total: number } | null;
  forestCancelExpandAll: (() => void) | null;
  forestExpandAllProgress: ExpandAllProgress | null;
  isExpandingAll: boolean;
  isForestExpandingAll: boolean;
}): {
  cancel: () => void;
  isExpanding: boolean;
  progress: { loaded: number; total: number } | null;
} {
  const {
    cancelExpandAll,
    expandAllProgress,
    forestCancelExpandAll,
    forestExpandAllProgress,
    isExpandingAll,
    isForestExpandingAll,
  } = args;
  if (isForestExpandingAll && forestCancelExpandAll) {
    return {
      cancel: forestCancelExpandAll,
      isExpanding: true,
      progress: forestExpandAllProgress,
    };
  }
  return { cancel: cancelExpandAll, isExpanding: isExpandingAll, progress: expandAllProgress };
}

/**
 * Toolbar tree-actions cluster incl. the scanning indicator — a LEAF over the
 * forest progress aggregate. The useForestExpandAllProgress subscription lives
 * HERE (not in FileExplorerPanelInner) so per-frame progress updates during a
 * forest sweep re-render only this small cluster, never the whole panel
 * (PR #1734 audit).
 */
const PanelTreeActionButtons = React.memo(
  ({
    cancellable,
    cancelExpandAll,
    expandAllProgress,
    forestCancelExpandAll,
    handleCancelOperation,
    isCancelling,
    isExpandingAll,
    isForestExpandingAll,
    isLoading,
    isRefreshing,
    loadingProgress,
    onRefresh,
  }: {
    cancellable: boolean;
    cancelExpandAll: () => void;
    expandAllProgress: { loaded: number; total: number } | null;
    forestCancelExpandAll: (() => void) | null;
    handleCancelOperation: () => void;
    isCancelling: boolean;
    isExpandingAll: boolean;
    isForestExpandingAll: boolean;
    isLoading: boolean;
    isRefreshing: boolean;
    loadingProgress: { isInitialLoading?: boolean } | null | undefined;
    onRefresh: () => void;
  }) => {
    const forestExpandAllProgress = useForestExpandAllProgress();
    // During a forest sweep the indicator reads the registry's aggregate
    // progress and cancels the forest run; otherwise the focused provider's
    // expand state.
    const scanningStatus = useMemo(() => {
      const source = resolveExpandAllScanningSource({
        cancelExpandAll,
        expandAllProgress,
        forestCancelExpandAll,
        forestExpandAllProgress,
        isExpandingAll,
        isForestExpandingAll,
      });
      return computeScanningStatusProps({
        cancelExpandAll: source.cancel,
        cancellable,
        expandAllProgress: source.progress,
        handleCancelOperation,
        isCancelling,
        isExpandingAll: source.isExpanding,
        loadingProgress,
      });
    }, [
      cancellable,
      cancelExpandAll,
      expandAllProgress,
      forestCancelExpandAll,
      forestExpandAllProgress,
      handleCancelOperation,
      isCancelling,
      isExpandingAll,
      isForestExpandingAll,
      loadingProgress,
    ]);

    return (
      <TreeActionButtons
        isExpandingAll={isExpandingAll || isForestExpandingAll}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        onRefresh={onRefresh}
        scanningStatus={scanningStatus}
      />
    );
  }
);

PanelTreeActionButtons.displayName = 'PanelTreeActionButtons';

/**
 * Mounts the floating Expand/Collapse All cluster over the tree area once a
 * workspace root exists (same gate as the toolbar's tree-actions cluster).
 * Kept as its own leaf so the gating branch lives outside the panel body.
 */
const PanelFloatingTreeActions = ({
  hasRoot,
  isExpandingAll,
  isLoading,
  isRefreshing,
  onCollapseAll,
  onExpandAll,
}: {
  hasRoot: boolean;
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) => {
  if (!hasRoot) {
    return null;
  }
  return (
    <FloatingTreeActions
      isExpandingAll={isExpandingAll}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      onCollapseAll={onCollapseAll}
      onExpandAll={onExpandAll}
    />
  );
};

/**
 * Staged forest expand-all: sweeping every root's full subtree is I/O-heavy
 * and easy to trigger by accident, so the toolbar click only opens a confirm
 * dialog; the sweep starts on confirm. Single-root expand stays immediate.
 */
function useForestExpandConfirm(forestActions: ForestTreeActionsValue | null): {
  confirm: () => void;
  dismiss: () => void;
  isOpen: boolean;
  stage: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const stage = useCallback(() => setIsOpen(true), []);
  const dismiss = useCallback(() => setIsOpen(false), []);
  const confirm = useCallback(() => {
    setIsOpen(false);
    void forestActions?.runExpandAll();
  }, [forestActions]);
  // Memoized: this object feeds the toolbar's memoized expand-all callback.
  return useMemo(() => ({ confirm, dismiss, isOpen, stage }), [confirm, dismiss, isOpen, stage]);
}

/**
 * Aggregate user feedback for a forest-wide select-all sweep (sections run
 * quiet — per-root toasts would fire once per section). Null = success with
 * room to spare, no toast needed.
 */
function buildForestSelectAllFeedback(
  summary: { limitReached: boolean; selected: number },
  maxCount: number
): { title: string; description: string } | null {
  if (summary.selected === 0) {
    return {
      description: summary.limitReached
        ? `The selection limit (${maxCount}) is already used by existing selections.`
        : 'Everything is hidden by the current view filters. Adjust the workspace filters to select files.',
      title: 'No selectable files in any folder',
    };
  }
  if (summary.limitReached) {
    return {
      description: `Selected ${summary.selected} files before hitting the limit. Raise the limit to select more.`,
      title: `Selection limit reached (${maxCount})`,
    };
  }
  return null;
}

/**
 * FOREST MODE toolbar Select All: sweep EVERY root section through its own
 * tree context — the panel provider's tree is the invisible legacy one and
 * is empty/stale for non-focused roots ("No selectable files in view" on
 * roots whose sections clearly show files). The forest-union budget composes
 * per pass inside selectAllRecursively; this owns the ONE aggregate toast.
 */
async function runForestSelectAllSweep(args: {
  forestActions: ReturnType<typeof useOptionalForestTreeActions>;
  maxCount: number;
  showToast: (toast: { title: string; description: string }) => void;
}): Promise<{
  success: boolean;
  filePaths: string[];
  totalAvailable?: number;
  limitReached?: boolean;
  error?: string;
}> {
  if (!args.forestActions) {
    return { error: 'Forest registry unavailable', filePaths: [], success: false };
  }
  const summary = await args.forestActions.runSelectAll();
  const feedback = buildForestSelectAllFeedback(summary, args.maxCount);
  if (feedback) {
    args.showToast(feedback);
  }
  return {
    filePaths: [],
    limitReached: summary.limitReached,
    success: true,
    totalAvailable: summary.selected,
  };
}

/**
 * Toolbar Select All wiring: forest mode swaps in the registry sweep, the
 * forest-wide quick-filter override, and treats the tree as non-empty
 * (sections own their trees — the focused panel tree is the invisible
 * legacy one).
 */
function resolveSelectAllWiring<T>(args: {
  fileTreeLength: number;
  forestActions: ReturnType<typeof useOptionalForestTreeActions>;
  forestQuickFilterSelectAll: () => void;
  forestSelectAll: T;
  isForestMode: boolean;
  selectAllRecursively: T;
}): {
  hasFilesInTree: boolean;
  quickFilterSelectAllOverride: (() => void) | undefined;
  selectAll: T;
} {
  if (args.isForestMode && args.forestActions) {
    return {
      hasFilesInTree: true,
      quickFilterSelectAllOverride: args.forestQuickFilterSelectAll,
      selectAll: args.forestSelectAll,
    };
  }
  return {
    hasFilesInTree: args.fileTreeLength > 0,
    quickFilterSelectAllOverride: undefined,
    selectAll: args.selectAllRecursively,
  };
}

/** Single-root path: progressive expand-all over the focused provider's tree. */
function runFocusedTreeExpandAll(
  store: ReturnType<typeof useFileExplorerStoreContext>,
  expandAllProgressively: (
    setExpandedPaths: (updater: (prev: Set<string>) => Set<string>) => void,
    currentExpandedPaths: Set<string>
  ) => unknown,
  fileTree: IFileNode[] | undefined
): void {
  if (!(fileTree && fileTree.length > 0)) {
    logger.warn('expandAll: no file tree or empty tree');
    return;
  }
  logger.info('expandAll: calling expandAllProgressively');
  const setExpandedPaths = (updater: (prev: Set<string>) => Set<string>) => {
    const currentPaths = store.getState().expandedDirectoryPaths;
    const newPaths = updater(currentPaths);
    if (newPaths === currentPaths) {
      return;
    }
    store.getState().setExpandedPaths(newPaths);
  };
  void expandAllProgressively(setExpandedPaths, store.getState().expandedDirectoryPaths);
}

/**
 * FileExplorerPanel - Contains the file tree and toolbar
 * This component can be used independently in a panel of an IDE layout
 */
const FileExplorerPanelInner = React.memo(() => {
  const { fileSystemAdapter, storageAdapter } = useAdapters();
  const store = useFileExplorerStoreContext();
  // Persist + restore the explorer scroll position across sessions. Wired to the
  // outer scroll root; the hook resolves the active (single-root vs forest)
  // scroller and captures via a capture-phase listener.
  const explorerScrollRootRef = React.useRef<HTMLDivElement | null>(null);
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
  const [isRestoring, setIsRestoring] = useState(false);
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
    addRootDirectory,
    registerRestoredHandles,
    removeRootDirectory,
    setFocusedRoot,
    rootIdByPath,
    unfilteredFileTree,
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
  const handleSelectFolderRecursively = useCallback(
    async (node: IFileNode) => {
      // The node carries its OWN root identity (stamped by every tree loader
      // since storage v5) — the focused root's id is WRONG for clicks inside
      // another root's tree in forest mode. Focused-root resolution remains
      // only as the fallback for legacy nodes without a rootFolderId.
      const folderId =
        node.rootFolderId ||
        (getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? currentFolderId ?? '');
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
      rootIdByPath,
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

  // Get selection model for query-mode token counting and display
  const selectionModel = useFileExplorerStoreSelector((s) => s.selectionModel);

  const largeSelectionDiagnosticSignatureRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
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
    electronFileReader,
    fileTree: stableFileTree,
    selectedFiles: selectedFilePaths,
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
  const quickFilteredTree = useMemo(
    () => (stableFileTree ? applyQuickFilterToTree(stableFileTree, deferredQuickFilter) : null),
    [deferredQuickFilter, stableFileTree]
  );

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

  const handleRefresh = useCallback(async () => {
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
  }, [handleDirectorySelect, rootDirectoryHandles, addRootDirectory, handleDirectorySelectError]);

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
    // rootIdByPath gets a new Map identity on each root registration; the
    // effect body is idempotent when the resolved id is stable, so the extra
    // re-fires are safe.
    rootIdByPath,
    setCurrentFolderId,
    hydrateFolderState,
    store,
    isCheckingStoredHandles,
    pendingRestore,
    showDeniedBanner,
    showStaleBanner,
  ]);

  // Forest mode: Expand All must run inside EACH root section's own tree
  // context — the legacy path below only expands the focused provider's
  // (invisible) top-level tree when multiple roots are active.
  const forestActions = useOptionalForestTreeActions();
  const isForestMode = isForestModeActive(rootDirectoryHandles);
  // Run-boundary signal only — high-frequency progress is subscribed by the
  // PanelTreeActionButtons leaf, never by this panel component.
  const isForestExpandingAll = useForestIsExpandingAll();

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
    if (isExpandingAll || isForestExpandingAll) {
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
    isForestExpandingAll,
    isForestMode,
    stageForestExpandConfirm,
    store,
    expandAllProgressively,
    isExpandingAll,
  ]);

  const collapseAll = useCallback(() => {
    // Cancel any in-progress expand-all first (every section + the legacy path),
    // then clear the workspace-global expansion set — all sections collapse.
    forestActions?.cancelExpandAll();
    cancelExpandAll();
    store.getState().collapseAllDirectories();
    // Forest mode: one click means FULLY compact — the root section headers
    // close too, not just the directories under them (BST-571).
    forestActions?.collapseAllSections();
  }, [forestActions, store, cancelExpandAll]);

  const forestSelectAll = useCallback<typeof selectAllRecursively>(
    (_filteredTree, _folderId, _addFiles, maxCount) =>
      runForestSelectAllSweep({ forestActions, maxCount, showToast }),
    [forestActions, showToast]
  );
  // FOREST quick-filter Select All: select the visible search matches across
  // EVERY section (composite keys through the union-partitioning setter) —
  // no scanning beyond what the user sees, capped at the selection limit.
  const forestQuickFilterSelectAll = useCallback(() => {
    const keys = (forestActions?.collectVisibleQuickFilterKeys() ?? []).slice(0, maxSelectionCount);
    if (keys.length === 0) {
      showToast({
        description: 'No visible files match the quick filter in any folder.',
        title: 'No files match the search',
      });
      return;
    }
    setSelectedFilesFromList(keys);
  }, [forestActions, maxSelectionCount, setSelectedFilesFromList, showToast]);
  const selectAllWiring = resolveSelectAllWiring({
    fileTreeLength: fileTree.length,
    forestActions,
    forestQuickFilterSelectAll,
    forestSelectAll,
    isForestMode,
    selectAllRecursively,
  });

  const handleCancelOperation = useCallback(() => {
    cancelOperation();
    showToast({
      description: 'The file loading operation has been cancelled.',
      title: 'Operation Cancelled',
      variant: 'default',
    });
  }, [cancelOperation, showToast]);

  return (
    <FileExplorerErrorBoundary>
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
                className="flex min-w-0 items-center @[128px]:gap-1.5 gap-0.5"
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
                <div className="@[72px]:block hidden" data-testid="selection-counter-control">
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
                  forestCancelExpandAll={forestActions?.cancelExpandAll ?? null}
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
          />
          {/* Filter section: one toggled block (driven from the toolbar's
              view-filters button) hosting the preset row, the filter chips, and
              the quick-filter row. grid-rows 0fr->1fr animates to natural
              content height (unlike a max-height cap, which clips when many
              filter chips wrap). */}
          {rootDirectoryHandle && (
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
                      className="@[300px]:h-9 h-8 min-w-0 flex-1"
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
          )}
        </div>

        {/* Scrollable Middle Content - File Tree */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Restoration indicator - floats above the tree as an overlay so
              mounting/unmounting never shifts the tree rows below it. */}
          <div className="pointer-events-none absolute inset-x-2 top-2 z-10">
            <RestorationStatus
              isRestoring={isRestoringExpandedPaths}
              progress={restorationProgress}
            />
          </div>
          {/* Expand/Collapse All float over the tree's (usually empty)
              top-right corner instead of crowding the toolbar (BST-571).
              Same overlay contract as RestorationStatus: never shifts rows. */}
          <PanelFloatingTreeActions
            hasRoot={Boolean(rootDirectoryHandle)}
            isExpandingAll={isExpandingAll || isForestExpandingAll}
            isLoading={isLoading}
            isRefreshing={isRefreshing}
            onCollapseAll={collapseAll}
            onExpandAll={expandAll}
          />
          {/* Scrollable content — scroll root for session scroll restore */}
          <div
            className="h-full overflow-y-auto"
            data-testid="explorer-scroll-root"
            ref={explorerScrollRootRef}
          >
            <Suspense fallback={<LoadingFallback />}>
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
                rootDirectoryHandle={rootDirectoryHandle}
                rootDirectoryHandles={rootDirectoryHandles}
                rootIdByPath={rootIdByPath}
                setFocusedRoot={setFocusedRoot}
                treeError={error}
              />
            </Suspense>
          </div>
        </div>

        {/* Forest Expand All confirmation - multi-root sweeps are staged */}
        <ExpandAllConfirmDialog
          onCancel={forestExpandConfirm.dismiss}
          onConfirm={forestExpandConfirm.confirm}
          open={forestExpandConfirm.isOpen}
          rootCount={rootDirectoryHandles.length}
        />

        {/* Restore Access Modal - shown when stored handles exist but need permission */}
        <RestoreAccessModal
          folderNames={
            storedFolders.length > 0
              ? storedFolders.map((f) => f.name)
              : pendingRestore?.name
                ? [pendingRestore.name]
                : ['previous folder']
          }
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
                  _internal: handle,
                  kind: 'directory' as const,
                  name: handle.name,
                  path: handle.name,
                  platform: 'web' as const,
                  // Stamp the durable rootId (pendingRestore.folderId IS the rootId,
                  // keyed in the handle cache) so the eager setRootDirectoryHandle and
                  // the registerRestoredHandles burst below reconcile to ONE root by
                  // rootKey — identity is rootId-only, no path fallback. Conditional
                  // spread keeps the field absent (not undefined) under
                  // exactOptionalPropertyTypes; ensureStamped is the loud backstop.
                  ...(pendingRestore?.folderId ? { rootId: pendingRestore.folderId } : {}),
                };
                // beginRestore's burst seeds its result with already-granted
                // handles (incl. this one), so registering its FULL return is
                // the multi-root-complete path; the eager single-handle set
                // keeps the focused tree responsive while the burst settles.
                setRootDirectoryHandle(directoryHandle);
                beginRestore()
                  .then((restoredHandles) =>
                    restoredHandles.length > 0
                      ? registerRestoredHandles(restoredHandles)
                      : undefined
                  )
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
                      .then((restoredHandles) => registerRestoredHandles(restoredHandles))
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
                    .then((restoredHandles) => registerRestoredHandles(restoredHandles))
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
              .then((restoredHandles) => registerRestoredHandles(restoredHandles))
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

FileExplorerPanelInner.displayName = 'FileExplorerPanelInner';

/**
 * Public panel: wraps the inner panel with the forest tree-actions registry
 * so toolbar Expand All / Collapse All can drive every root section's own
 * tree context (the inner panel and the sidebar sections both consume it).
 */
export const FileExplorerPanel = () => (
  <ForestTreeActionsProvider>
    <FileExplorerPanelInner />
  </ForestTreeActionsProvider>
);

FileExplorerPanel.displayName = 'FileExplorerPanel';
