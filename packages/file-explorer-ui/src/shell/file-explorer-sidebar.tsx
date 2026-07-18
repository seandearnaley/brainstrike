import type { DirectoryHandle } from '@brainstrike/file-system';
import { useFileFilters } from '@brainstrike/hooks';
import type { IFileNode } from '@brainstrike/types';
import { EmptyState, LightweightCheckbox } from '@brainstrike/ui';
import { FolderOpen, Loader2 } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { DisconnectRootDialog } from '../components/disconnect-root-dialog';
import { RootSectionHeader } from '../components/root-section-header';
import { FileTreeProvider, useFileTreeContext } from '../tree/file-tree-provider';
import OptimizedFileTree from '../tree/optimized-file-tree';
import { getRootFolderId } from '../utils/get-root-folder-id';
import { collectVisibleFiles, useQuickFilteredTree } from '../utils/quick-filter-tree';
import { getSelectionCount } from '../utils/selection-projection';
import { useActiveWorkspaceFilters } from '../utils/workspace-filter-selectors';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useOptionalForestTreeActions } from './forest-tree-actions-context';
import { useSelectionManager } from './use-selection-manager-context';

// Shown when the workspace has no active roots. Multi-root: the workspace can
// hold many folders, so this prompts adding one rather than "selecting a root".
const NoWorkspaceFolders = () => (
  <EmptyState
    description="Add a folder to browse and select its files."
    icon={<FolderOpen />}
    title="No folders in your workspace"
  />
);

/**
 * Loading indicator shown during Select All operations.
 * Uses a subtle overlay with spinner to indicate work in progress
 * without being too intrusive.
 */
const SelectAllLoadingIndicator = () => (
  <div
    className="absolute inset-0 z-30 flex items-center justify-center bg-background/50"
    data-testid="select-all-loading-overlay"
  >
    <div className="flex items-center gap-2 rounded-md bg-background/90 px-3 py-2 shadow-sm">
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span className="text-muted-foreground text-xs">Selecting files...</span>
    </div>
  </div>
);

interface FileExplorerSidebarProps {
  /** Cancel loading for a directory (called on collapse) */
  cancelChildLoading?: ((path: string) => void) | undefined;
  currentFolderId: string | null;
  filterError: Error | null;
  /**
   * True when `quickFilteredTree` removed anything relative to the canonical
   * (unfiltered) tree. False lets the single-root tree skip its O(N)
   * filtered-path-set build; omit when unknown (conservative legacy build).
   */
  isDisplayTreeFiltered?: boolean | undefined;
  isInitialLoad: boolean;
  isLoading: boolean;
  /** Whether the entire tree is being loaded for select all */
  isLoadingForSelectAll?: boolean | undefined;
  /** Whether a folder is being loaded for selection */
  isLoadingForSelection?: boolean | undefined;
  loadingFiles: Set<string>;
  /** Path of the folder being loaded for selection */
  loadingPathForSelection?: string | null | undefined;
  /** Set of paths currently loading their children (lazy loading) */
  loadingPaths?: Set<string> | undefined;
  /** Callback to load children of a directory on expand (lazy loading) */
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  /**
   * Disconnect a root by RootId (multi-root, Phase 5). When provided, each
   * forest-mode section header shows a disconnect (X) button guarded by a
   * confirmation dialog. Disconnect ≠ delete: indexed DB rows are kept.
   */
  onRemoveRoot?:
    | ((rootId: string, options?: { deleteData?: boolean }) => Promise<void>)
    | undefined;
  /** Select all files in a folder recursively, loading if needed */
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  onTreeRender?: (() => void) | undefined;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
  /** All active root handles. When length > 1, renders a forest (one tree per root). */
  rootDirectoryHandles?: DirectoryHandle[] | undefined;
  /**
   * Maps handle.path → RootId UUID (storage v5).
   * Used to resolve the durable identity for `OptimizedFileTree`'s `folderId` prop.
   * When absent the sidebar falls back to `getRootFolderId(handle)` (path).
   */
  rootIdByPath?: ReadonlyMap<string, string> | undefined;
  /** Switch focus to the root at the given path (forest mode). */
  setFocusedRoot?: ((path: string) => void) | undefined;
  treeError: Error | null;
}

const ErrorDisplay = ({
  treeError,
  filterError,
}: {
  treeError?: Error | null;
  filterError?: Error | null;
}) => (
  <div
    className="m-2 rounded border border-red-400 bg-red-100 p-3 text-red-700 text-sm dark:border-red-700 dark:bg-red-900 dark:text-red-200"
    role="alert"
  >
    <strong>Error: </strong>
    {treeError?.message}
    {filterError && ` ${filterError.message}`}
  </div>
);

const EmptyStateComponent = ({
  isLoading,
}: {
  isLoading: boolean;
  quickFilteredTree: IFileNode[] | null;
  rootDirectoryHandle: DirectoryHandle | null;
}) => (
  <div className="py-8 text-center text-muted-foreground">
    {isLoading ? 'Loading files...' : 'No matching files found'}
  </div>
);

/** First few patterns + a count, e.g. "*.tsx, *.ts, *.js, +2 more". */
function formatFilterHint(patterns: readonly string[]): string {
  const shown = patterns.slice(0, 3).join(', ');
  return patterns.length > 3 ? `${shown}, +${patterns.length - 3} more` : shown;
}

function forestEmptyStateMessage(args: {
  includeFilters: readonly string[];
  isFilteredOut: boolean;
  isLoading: boolean;
  quickFilter: string;
}): string {
  if (args.isLoading) {
    return 'Loading files…';
  }
  if (args.quickFilter.trim().length > 0) {
    return `No files match the search "${args.quickFilter.trim()}"`;
  }
  if (args.isFilteredOut) {
    // Name the offending patterns — "a filter was applied but the dropdown
    // said All Files" must be self-diagnosing from the empty state alone.
    return args.includeFilters.length > 0
      ? `No files match the view filters (${formatFilterHint(args.includeFilters)})`
      : 'All files here are hidden by the exclude filters';
  }
  return 'No files in this folder';
}

/**
 * Compact per-section empty state for forest mode. The full-height
 * single-tree empty state reads as a giant blank gap between root sections,
 * so a section with no visible rows gets ONE line that says why.
 */
const ForestSectionEmptyState = ({
  isLoading,
  isFilteredOut,
}: {
  isLoading: boolean;
  isFilteredOut: boolean;
}) => {
  const { includeFilters } = useActiveWorkspaceFilters();
  const quickFilter = useFileExplorerStoreSelector((s) => s.quickFilter);
  return (
    <div className="px-9 py-1.5 text-muted-foreground text-xs">
      {forestEmptyStateMessage({ includeFilters, isFilteredOut, isLoading, quickFilter })}
    </div>
  );
};

/**
 * Inner component for a root section's tree content.
 * Must be rendered inside a FileTreeProvider so it can read the per-root tree
 * from context. Any click inside the tree container bubbles to the parent
 * RootSection's onClick handler which switches focus to this root.
 */
interface PerRootTreePaneProps {
  cancelChildLoading?: ((path: string) => void) | undefined;
  currentFolderId: string | null;
  isLoading: boolean;
  isLoadingForSelectAll?: boolean | undefined;
  isLoadingForSelection?: boolean | undefined;
  loadingFiles: Set<string>;
  loadingPathForSelection?: string | null | undefined;
  loadingPaths?: Set<string> | undefined;
  onLoadChildren?: ((path: string) => Promise<void>) | undefined;
  onSelectFolderRecursively?:
    | ((node: IFileNode) => Promise<{ success: boolean; filePaths: string[] }>)
    | undefined;
  onTreeRender?: (() => void) | undefined;
  rootDirectoryHandle: DirectoryHandle;
  /**
   * Durable RootId UUID for this root (storage v5). When provided, used as
   * `folderId` for OptimizedFileTree instead of the handle path.
   */
  rootId?: string | undefined;
  /**
   * The forest sections column (single scroll owner). Each section's tree
   * virtualizes against it via TreeTable's shared-scroller mode — a
   * per-section scrollbar inside the scrolling column stretches to content
   * height and freezes the virtual window (blank rows on scroll).
   */
  scrollParentRef?: React.RefObject<HTMLElement | null> | undefined;
}

/**
 * Forest sections run recursive folder selection through their OWN tree
 * context. The shared panel prop is bound to the FOCUSED root's provider —
 * its getSubtreeByPath and loading state are wrong for every other section
 * (and could even shadow a same-named path in another root).
 */
function useSectionRecursiveSelect(folderId: string): {
  isLoadingForSelection: boolean;
  loadingPathForSelection: string | null;
  onSelectFolderRecursively: (
    node: IFileNode
  ) => Promise<{ success: boolean; filePaths: string[] }>;
} {
  const treeContext = useFileTreeContext();
  const sectionSelectFolderRecursively = treeContext.selectFolderRecursively;
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const addMultipleSelectedFilesChunked = useFileExplorerStoreSelector(
    (s) => s.addMultipleSelectedFilesChunked
  );
  const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
  const { selectedCount, selectedFilesList } = useSelectionManager();

  const onSelectFolderRecursively = useCallback(
    async (node: IFileNode) => {
      // The node carries its own root identity (stamped by every tree loader
      // since storage v5); the section folderId is only a legacy fallback.
      const targetFolderId = node.rootFolderId || folderId;
      const selectedDescendantCount = selectedFilesList.filter((selectionKey) =>
        selectionKey.startsWith(`${targetFolderId}|@|${node.path}/`)
      ).length;
      return sectionSelectFolderRecursively(
        node,
        targetFolderId,
        addMultipleSelectedFiles,
        maxSelectionCount,
        selectedCount,
        selectedDescendantCount,
        addMultipleSelectedFilesChunked
      );
    },
    [
      addMultipleSelectedFiles,
      addMultipleSelectedFilesChunked,
      folderId,
      maxSelectionCount,
      sectionSelectFolderRecursively,
      selectedCount,
      selectedFilesList,
    ]
  );

  return {
    isLoadingForSelection: treeContext.isLoadingForSelection,
    loadingPathForSelection: treeContext.loadingPathForSelection,
    onSelectFolderRecursively,
  };
}

/**
 * Apply the WORKSPACE-GLOBAL view filters to a section's tree for display.
 * Every forest section filters through this one derivation so what the tree
 * shows is exactly what scans and select-all can select — the filters are
 * global, so all trees agree by construction.
 */
function useGlobalFilteredTree(tree: IFileNode[]): IFileNode[] {
  const { includeFilters, excludeFilters, useRegex } = useActiveWorkspaceFilters();
  const { applyFileFilters } = useFileFilters();
  return useMemo(
    () => applyFileFilters(tree, includeFilters, excludeFilters, useRegex),
    [applyFileFilters, tree, includeFilters, excludeFilters, useRegex]
  );
}

/** Count visible files in a (filtered) section tree + whether any directory is still unloaded. */
function countTreeFiles(nodes: readonly IFileNode[]): { files: number; hasUnloaded: boolean } {
  let files = 0;
  let hasUnloaded = false;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'file') {
      files += 1;
    } else if (node.type === 'directory') {
      if (node.loadState !== 'loaded') {
        hasUnloaded = true;
      }
      if (node.children) {
        stack.push(...node.children);
      }
    }
  }
  return { files, hasUnloaded };
}

/**
 * Tristate select-all checkbox for one root section. Lives INSIDE the
 * section's FileTreeProvider so it runs the SECTION-scoped select-all over
 * this root's own tree. Selection reads mirror OptimizedFileTree's
 * focused/foreign derivation (the null-focus guard MUST match the store's
 * write routing): focused root → effective top-level count (explicit set or
 * query manifest), any other root → its folderState.
 *
 * Tristate totals arrive via `visibleFileTotals`, counted over the SHARED
 * per-section view-filtered tree (RootSectionInner) — the checkbox never
 * re-filters or re-walks the tree itself, and never disagrees with the pane.
 */
function RootSelectAllCheckbox({
  displayName,
  folderId,
  visibleFileTotals,
}: {
  displayName: string;
  folderId: string;
  visibleFileTotals: { files: number; hasUnloaded: boolean };
}) {
  const treeContext = useFileTreeContext();
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const addMultipleSelectedFilesChunked = useFileExplorerStoreSelector(
    (s) => s.addMultipleSelectedFilesChunked
  );
  const maxSelectionCount = useFileExplorerStoreSelector((s) => s.maxSelectionCount);
  const clearSelectedFiles = useFileExplorerStoreSelector((s) => s.clearSelectedFiles);
  const setFolderSelection = useFileExplorerStoreSelector((s) => s.setFolderSelection);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const selectionCount = useFileExplorerStoreSelector((s) => {
    const isForeign = s.currentFolderId !== null && folderId !== s.currentFolderId;
    if (isForeign) {
      return s.folderStates[folderId]?.selectedFilePaths.size ?? 0;
    }
    return getSelectionCount(s.selectionModel, s.selectedFilePaths, s.querySelectionManifest);
  });

  const { files: totalVisibleFiles, hasUnloaded } = visibleFileTotals;

  // Tristate: "all selected" is only claimable when every subtree is loaded
  // and the (filtered) visible file count is fully covered.
  const checked: boolean | 'indeterminate' =
    selectionCount === 0
      ? false
      : hasUnloaded || selectionCount < totalVisibleFiles
        ? 'indeterminate'
        : true;

  const sectionFileTree = treeContext.fileTree;
  const sectionSelectAll = treeContext.selectAllRecursively;
  const handleCheckedChange = useCallback(() => {
    if (selectionCount > 0) {
      // Clear THIS root's selection only.
      if (currentFolderId === null || currentFolderId === folderId) {
        clearSelectedFiles();
      } else {
        setFolderSelection(folderId, []);
      }
      return;
    }
    void sectionSelectAll(
      sectionFileTree,
      folderId,
      addMultipleSelectedFiles,
      maxSelectionCount,
      addMultipleSelectedFilesChunked
    );
  }, [
    addMultipleSelectedFiles,
    addMultipleSelectedFilesChunked,
    clearSelectedFiles,
    currentFolderId,
    folderId,
    maxSelectionCount,
    sectionFileTree,
    sectionSelectAll,
    selectionCount,
    setFolderSelection,
  ]);

  return (
    <LightweightCheckbox
      aria-label={`Select all in ${displayName}`}
      checked={checked}
      className="h-3.5 w-3.5"
      disabled={treeContext.isLoadingForSelectAll}
      onCheckedChange={handleCheckedChange}
    />
  );
}

// NOTE: the shared panel props ALSO carry loadingPaths/onLoadChildren/
// cancelChildLoading/onSelectFolderRecursively/isLoadingForSelection/
// loadingPathForSelection, but those are bound to the FOCUSED root's
// provider — forest sections deliberately ignore them and use their own
// tree context.
const PerRootTreePane = ({
  rootDirectoryHandle,
  loadingFiles,
  currentFolderId,
  onTreeRender,
  isLoadingForSelectAll = false,
  isLoading: isLoadingProp,
  rootId,
  scrollParentRef,
  displayTree,
  isDisplayTreeFiltered,
}: PerRootTreePaneProps & SectionDisplayTreeProps) => {
  // The section's SHARED display derivation (view filters + quick filter over
  // the deferred canonical tree) arrives via props from RootSectionInner —
  // the pane and the header checkbox consume ONE filtering pass. The
  // canonical tree stays available through the tree context for
  // loading/selection/actions.
  const treeContext = useFileTreeContext();
  const isLoading = treeContext.isLoading || isLoadingProp;
  const hasContent = displayTree.length > 0;
  // Lazy loading MUST use THIS section's tree loader: the shared panel props
  // are bound to the FOCUSED root's provider, so routing expansion through
  // them loads children into the invisible top-level tree and this section
  // never updates (folders silently fail to open).
  const sectionLoadChildren = treeContext.loadChildren;
  const sectionCancelChildLoading = treeContext.cancelChildLoading;
  const sectionLoadingPaths = treeContext.loadingPaths;
  // Storage v5: use durable RootId UUID when available so the folderId
  // matches IFileNode.rootFolderId (linchpin equality).
  const folderId = rootId ?? getRootFolderId(rootDirectoryHandle) ?? currentFolderId ?? '';
  const sectionRecursiveSelect = useSectionRecursiveSelect(folderId);

  // Register this section's expand-all AND select-all with the forest
  // registry so the toolbar actions run INSIDE this root's tree context
  // (routing them through the focused panel provider only touches the
  // invisible top-level tree — the recurring forest disease, toolbar
  // edition). Expansion paths land in the workspace-global expanded set.
  const store = useFileExplorerStoreContext();
  const forestActions = useOptionalForestTreeActions();
  const sectionExpandAllProgressively = treeContext.expandAllProgressively;
  const sectionCancelExpandAll = treeContext.cancelExpandAll;
  // Registration depends on these STABLE registry callbacks, never on the
  // whole context value — that value changes on every aggregate progress
  // update, which would churn register/unregister mid-run.
  const forestRegister = forestActions?.register;
  const forestReportExpandAllProgress = forestActions?.reportExpandAllProgress;
  const sectionSelectAll = treeContext.selectAllRecursively;
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const addMultipleSelectedFilesChunked = useFileExplorerStoreSelector(
    (s) => s.addMultipleSelectedFilesChunked
  );
  // The registry callbacks fire later than this render — read the LATEST
  // section state at call time, not what was captured at registration.
  const sectionTreeRef = useRef(treeContext.fileTree);
  const displayedTreeRef = useRef(displayTree);
  // Post-commit sync keeps render pure; the refs are only read from registry
  // callbacks, which always fire after the commit that scheduled them.
  useEffect(() => {
    sectionTreeRef.current = treeContext.fileTree;
    displayedTreeRef.current = displayTree;
  });
  useEffect(() => {
    if (!(forestRegister && forestReportExpandAllProgress)) {
      return;
    }
    return forestRegister(folderId, {
      cancelExpandAll: sectionCancelExpandAll,
      expandAll: async () => {
        const setExpandedPathsUpdater = (updater: (prev: Set<string>) => Set<string>) => {
          const currentPaths = store.getState().expandedDirectoryPaths;
          const nextPaths = updater(currentPaths);
          if (nextPaths !== currentPaths) {
            store.getState().setExpandedPaths(nextPaths);
          }
        };
        await sectionExpandAllProgressively(
          setExpandedPathsUpdater,
          store.getState().expandedDirectoryPaths,
          // Push progress at the event source: this section's counts live in
          // ITS tree provider, which the panel toolbar cannot see.
          (loaded, total) => forestReportExpandAllProgress(folderId, { loaded, total })
        );
      },
      getVisibleQuickFilterKeys: () => {
        // Composite keys of the files currently DISPLAYED in this section
        // (view filters + quick filter applied) — quick-filter Select All
        // selects exactly what the user sees, no scanning beyond it.
        const visible = new Set<string>();
        collectVisibleFiles(displayedTreeRef.current, visible);
        return Array.from(visible, (path) => `${folderId}|@|${path}`);
      },
      selectAll: async () => {
        // Quiet pass: the forest sweep owns aggregate feedback (per-root
        // zero-match/limit toasts would fire once per section).
        const result = await sectionSelectAll(
          sectionTreeRef.current,
          folderId,
          addMultipleSelectedFiles,
          store.getState().maxSelectionCount,
          addMultipleSelectedFilesChunked,
          { quiet: true }
        );
        return {
          limitReached: result.limitReached === true,
          selected: result.filePaths.length,
        };
      },
    });
  }, [
    addMultipleSelectedFiles,
    addMultipleSelectedFilesChunked,
    forestRegister,
    forestReportExpandAllProgress,
    folderId,
    sectionExpandAllProgressively,
    sectionCancelExpandAll,
    sectionSelectAll,
    store,
  ]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {isLoadingForSelectAll && <SelectAllLoadingIndicator />}
      {hasContent ? (
        <OptimizedFileTree
          cancelChildLoading={sectionCancelChildLoading}
          fileTree={displayTree}
          folderId={folderId}
          isDisplayTreeFiltered={isDisplayTreeFiltered}
          isLoadingForSelection={sectionRecursiveSelect.isLoadingForSelection}
          loadingFiles={loadingFiles}
          loadingPathForSelection={sectionRecursiveSelect.loadingPathForSelection}
          loadingPaths={sectionLoadingPaths}
          onLoadChildren={sectionLoadChildren}
          onRender={onTreeRender || undefined}
          onSelectFolderRecursively={sectionRecursiveSelect.onSelectFolderRecursively}
          scrollParentRef={scrollParentRef}
        />
      ) : (
        <ForestSectionEmptyState
          isFilteredOut={treeContext.fileTree.length > 0}
          isLoading={isLoading}
        />
      )}
    </div>
  );
};

/** One collapsible root section (header + tree) used in forest mode.
 *
 * Wraps its content in a dedicated FileTreeProvider so the root runs its own
 * useFileTree and shows its own real directory contents. Row interactions
 * (clicks anywhere inside the tree container) bubble to the section wrapper
 * and call setFocusedRoot — this is the per-root-boundary focus-switch site.
 */
interface RootSectionProps extends PerRootTreePaneProps {
  onRemoveRoot?:
    | ((rootId: string, options?: { deleteData?: boolean }) => Promise<void>)
    | undefined;
  rootIdByPath?: ReadonlyMap<string, string> | undefined;
  setFocusedRoot?: ((path: string) => void) | undefined;
}

/** The section's shared display-tree derivation, computed once per section. */
interface SectionDisplayTreeProps {
  /** View filters + quick filter applied over the deferred canonical tree. */
  displayTree: IFileNode[];
  /** True when filtering removed anything relative to the canonical tree. */
  isDisplayTreeFiltered: boolean;
}

interface RootSectionInnerProps extends RootSectionProps {
  resolvedRootId: string | undefined;
  rootIdentity: string;
}

/**
 * Section content INSIDE the FileTreeProvider. Owns the ONE shared display
 * derivation per section (PR #1734 audit): the workspace view filters, the
 * quick filter, and the visible-file totals are computed here once and fed to
 * BOTH the header's select-all checkbox and the tree pane — previously each
 * ran its own full-tree pass, doubling every filter walk per tree commit.
 *
 * The INPUT tree is deferred (useDeferredValue) BEFORE the filter passes, so
 * expand-all storms run the expensive filtering at deferred priority while
 * the canonical treeContext.fileTree stays immediate for loading/selection.
 */
const RootSectionInner = ({
  onRemoveRoot,
  rootDirectoryHandle,
  setFocusedRoot,
  resolvedRootId,
  rootIdentity,
  ...rest
}: Omit<RootSectionInnerProps, 'rootIdByPath'>) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDisconnectDialogOpen, setIsDisconnectDialogOpen] = useState(false);
  const treeContext = useFileTreeContext();
  const deferredFileTree = useDeferredValue(treeContext.fileTree);
  const viewFilteredTree = useGlobalFilteredTree(deferredFileTree);
  // The QUICK FILTER (search box) applies to every section's display too —
  // it is workspace-global state, and a search box that only filtered the
  // invisible panel tree silently did nothing in forest mode.
  const { tree: displayTree } = useQuickFilteredTree(viewFilteredTree);
  // Tristate totals count the VIEW-filtered tree (quick filter excluded, as
  // before): the checkbox reflects what select-all can select.
  const visibleFileTotals = useMemo(() => countTreeFiles(viewFilteredTree), [viewFilteredTree]);
  // Copy-on-write filters return the INPUT identity when nothing was removed,
  // so this identity check is exact for "display tree covers the canonical
  // (deferred) tree".
  const isDisplayTreeFiltered = displayTree !== deferredFileTree;

  const handleToggle = useCallback(() => {
    // Header click: focus this root AND toggle collapse.
    setFocusedRoot?.(rootIdentity);
    setIsCollapsed((v) => !v);
  }, [setFocusedRoot, rootIdentity]);

  const handleDisconnectRequest = useCallback(() => {
    setIsDisconnectDialogOpen(true);
  }, []);

  const handleDisconnectConfirm = useCallback(
    (options: { deleteData: boolean }) => {
      setIsDisconnectDialogOpen(false);
      // Legacy roots without a RootId use their path AS the id (matches
      // removeRootDirectory's path-doubles-as-id resolution).
      void onRemoveRoot?.(rootIdentity, options);
    },
    [onRemoveRoot, rootIdentity]
  );

  const handleTreeInteraction = useCallback(() => {
    // Any interaction inside the tree container (row click, key press, etc.)
    // switches focused root. This is the per-root-boundary wiring site: bubbled
    // clicks from OptimizedFileTree rows reach this handler which is cheaper
    // than wiring into every individual row's dispatch path.
    setFocusedRoot?.(rootIdentity);
  }, [setFocusedRoot, rootIdentity]);

  return (
    <>
      <RootSectionHeader
        displayName={rootDirectoryHandle.name}
        isCollapsed={isCollapsed}
        onDisconnect={onRemoveRoot ? handleDisconnectRequest : undefined}
        onToggleCollapse={handleToggle}
        selectionControl={
          <RootSelectAllCheckbox
            displayName={rootDirectoryHandle.name}
            folderId={resolvedRootId ?? getRootFolderId(rootDirectoryHandle) ?? ''}
            visibleFileTotals={visibleFileTotals}
          />
        }
      />
      <DisconnectRootDialog
        displayName={rootDirectoryHandle.name}
        onConfirm={handleDisconnectConfirm}
        onOpenChange={setIsDisconnectDialogOpen}
        open={isDisconnectDialogOpen}
      />
      {!isCollapsed && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: tree rows have their own keyboard handlers; this is a focus-switch affordance only
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: intentional event-bubbling capture boundary for focus-switch
        // biome-ignore lint/a11y/noStaticElementInteractions: intentional event-bubbling capture boundary for focus-switch
        <div onClick={handleTreeInteraction}>
          <PerRootTreePane
            displayTree={displayTree}
            isDisplayTreeFiltered={isDisplayTreeFiltered}
            rootDirectoryHandle={rootDirectoryHandle}
            rootId={resolvedRootId}
            {...rest}
          />
        </div>
      )}
    </>
  );
};

const RootSection = ({ rootDirectoryHandle, rootIdByPath, ...rest }: RootSectionProps) => {
  // Storage v5: the canonical identity for this root. Prefer the stamped
  // handle.rootId (collision-proof for same-named roots), then the path→rootId
  // map, then the path itself (legacy single-root). Focus/remove/keys must all
  // use THIS, never the raw path — two same-named web roots share a path.
  const resolvedRootId = rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path);
  const rootIdentity = resolvedRootId ?? rootDirectoryHandle.path;

  return (
    <div className="flex flex-col">
      {/* Each root gets its own FileTreeProvider so it runs its own useFileTree
          independently. The provider wraps the HEADER too so the per-root
          select-all checkbox can read this root's tree and run the
          section-scoped select-all. Keyed by resolvedRootId (UUID) when
          available — same-path roots with different UUIDs get distinct
          providers; falls back to handle.path for pre-v5 handles. */}
      <FileTreeProvider
        key={resolvedRootId ?? rootDirectoryHandle.path}
        rootDirectoryHandle={rootDirectoryHandle}
        {...(resolvedRootId !== undefined && { rootId: resolvedRootId })}
      >
        <RootSectionInner
          resolvedRootId={resolvedRootId}
          rootDirectoryHandle={rootDirectoryHandle}
          rootIdentity={rootIdentity}
          {...rest}
        />
      </FileTreeProvider>
    </div>
  );
};

const FileExplorerSidebar = memo(
  ({
    rootDirectoryHandle,
    rootDirectoryHandles,
    rootIdByPath,
    setFocusedRoot,
    treeError,
    filterError,
    quickFilteredTree,
    loadingFiles,
    isLoading,
    isInitialLoad,
    currentFolderId,
    onTreeRender,
    loadingPaths,
    onLoadChildren,
    onRemoveRoot,
    cancelChildLoading,
    onSelectFolderRecursively,
    isLoadingForSelection,
    loadingPathForSelection,
    isLoadingForSelectAll = false,
    isDisplayTreeFiltered,
  }: FileExplorerSidebarProps) => {
    // React 19: useDeferredValue keeps showing the old tree while new one renders
    // This prevents "flash" during rapid tree updates (like expand-all)
    const deferredTree = useDeferredValue(quickFilteredTree);

    // Forest mode single scroll owner: every section's TreeTable virtualizes
    // against this column (shared-scroller mode). Unconditional hook — forest
    // mode is a render-time branch below.
    const forestScrollRef = useRef<HTMLDivElement | null>(null);

    const showError = (treeError || filterError) && !isLoading && !isInitialLoad;

    // FOREST MODE: render one collapsible section per root when multiple roots are active.
    // When rootDirectoryHandles.length <= 1, fall through to the original single-tree layout.
    const forestHandles = rootDirectoryHandles ?? [];
    const isForestMode = forestHandles.length > 1;

    if (isForestMode) {
      // Each RootSection has its own FileTreeProvider internally — no quickFilteredTree
      // is passed per-section here (each section derives its tree from its provider).
      const sharedProps = {
        cancelChildLoading,
        currentFolderId,
        isLoading,
        isLoadingForSelectAll,
        isLoadingForSelection,
        loadingFiles,
        loadingPathForSelection,
        loadingPaths,
        onLoadChildren,
        onSelectFolderRecursively,
        onTreeRender,
        scrollParentRef: forestScrollRef,
      };

      return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-panel-surface">
          {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
          <div
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            data-testid="forest-sections-scroll"
            ref={forestScrollRef}
          >
            {forestHandles.map((handle) => (
              <RootSection
                // Prefer the stamped rootId — same-named web roots share a path,
                // so a path-keyed key would collide and React would reconcile
                // the two sections as one.
                key={handle.rootId ?? rootIdByPath?.get(handle.path) ?? handle.path}
                onRemoveRoot={onRemoveRoot}
                rootDirectoryHandle={handle}
                rootIdByPath={rootIdByPath}
                setFocusedRoot={setFocusedRoot}
                {...sharedProps}
              />
            ))}
          </div>
        </div>
      );
    }

    // SINGLE-ROOT LAYOUT (original, golden-path regression safety)
    const hasContent = deferredTree && deferredTree.length > 0;
    // Storage v5: resolve RootId for single-root mode folderId. getRootFolderId
    // already prefers the stamped handle.rootId, then the path→id map, then the
    // path — so it is the single canonical resolver here.
    const singleRootFolderId =
      getRootFolderId(rootDirectoryHandle, rootIdByPath) ?? currentFolderId ?? '';

    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-panel-surface">
        {showError && <ErrorDisplay filterError={filterError} treeError={treeError} />}
        {rootDirectoryHandle ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Subtle loading overlay during Select All operation */}
            {isLoadingForSelectAll && <SelectAllLoadingIndicator />}
            {hasContent ? (
              <OptimizedFileTree
                cancelChildLoading={cancelChildLoading}
                fileTree={deferredTree}
                folderId={singleRootFolderId}
                // The flag describes quickFilteredTree; while useDeferredValue
                // still shows the PREVIOUS tree, fall back to the conservative
                // legacy build (undefined) instead of mislabeling it.
                isDisplayTreeFiltered={
                  deferredTree === quickFilteredTree ? isDisplayTreeFiltered : undefined
                }
                isLoadingForSelection={isLoadingForSelection}
                loadingFiles={loadingFiles}
                loadingPathForSelection={loadingPathForSelection}
                loadingPaths={loadingPaths}
                onLoadChildren={onLoadChildren}
                onRender={onTreeRender || undefined}
                onSelectFolderRecursively={onSelectFolderRecursively}
              />
            ) : (
              <EmptyStateComponent
                isLoading={isLoading}
                quickFilteredTree={deferredTree}
                rootDirectoryHandle={rootDirectoryHandle}
              />
            )}
          </div>
        ) : (
          <div className="flex-1">
            <NoWorkspaceFolders />
          </div>
        )}
      </div>
    );
  }
);

export default FileExplorerSidebar;
