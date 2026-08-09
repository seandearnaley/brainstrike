import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Eye, EyeOff, MoreHorizontal, RefreshCw, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { FloatingTreeActions } from '../components/floating-tree-actions';
import { TreeActionButtons } from '../components/tree-action-buttons';
import { computeScanningStatusProps } from '../utils/scanning-status-props';
import type { useFileExplorerStoreContext } from './file-explorer-provider';
import {
  type ExpandAllProgress,
  type ForestTreeActionsValue,
  useForestExpandAllProgress,
  type useOptionalForestTreeActions,
} from './forest-tree-actions-context';

// Same scope as file-explorer-panel.tsx on purpose: createLogger caches by scope, so both modules share one logger instance.
const logger = createLogger('FileExplorerPanel');

/** Eye toggle for the filter-chips row (from #1192), extracted for the complexity cap. */
export function FilterChipsToggleButton({
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
export function ViewFiltersToggleButton({
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
            'relative @[236px]/explorer-toolbar:size-7 size-6 shrink-0 p-0',
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

type CompactRefreshState = 'disabled' | 'ready' | 'refreshing';
type CompactViewFiltersState = 'collapsed' | 'expanded';
type CompactToolbarActionsState =
  | { availability: 'unavailable' }
  | { availability: 'yielded-to-cancel' }
  | {
      availability: 'available';
      filters: CompactViewFiltersState;
      refresh: CompactRefreshState;
    };

/**
 * True while the toolbar's scanning indicator — and therefore its cancel — is
 * on screen. Mirrors computeScanningStatusProps' own visibility rule, and is
 * the signal that makes the compact menu yield the narrow track.
 *
 * Run-boundary only: it flips once per operation, never per progress frame, so
 * reading it in the panel does not defeat the PanelTreeActionButtons leaf.
 */
export function isCancellableOperationRunning(args: {
  isExpandingAll: boolean;
  isForestExpandingAll: boolean;
  loadingProgress: { isInitialLoading?: boolean } | null | undefined;
}): boolean {
  return (
    Boolean(args.loadingProgress?.isInitialLoading) ||
    args.isExpandingAll ||
    args.isForestExpandingAll
  );
}

interface CompactToolbarActionsInput {
  hasRoot: boolean;
  isFiltersExpanded: boolean;
  isLoading: boolean;
  /**
   * True while a cancellable operation (initial load, refresh, or an expand-all
   * sweep) is running. The 76px narrow track fits two 24px controls beside the
   * 12px gutter, and during an operation the second one must be the scanning
   * indicator's cancel — the compact menu's Refresh item is disabled anyway,
   * and View Filters can wait for the few seconds a sweep takes.
   */
  isOperationInProgress: boolean;
  isRefreshing: boolean;
}

export function resolveCompactToolbarActionsState({
  hasRoot,
  isFiltersExpanded,
  isLoading,
  isOperationInProgress,
  isRefreshing,
}: CompactToolbarActionsInput): CompactToolbarActionsState {
  if (!hasRoot) {
    return { availability: 'unavailable' };
  }
  if (isOperationInProgress) {
    return { availability: 'yielded-to-cancel' };
  }
  if (isRefreshing) {
    return {
      availability: 'available',
      filters: isFiltersExpanded ? 'expanded' : 'collapsed',
      refresh: 'refreshing',
    };
  }
  if (isLoading) {
    return {
      availability: 'available',
      filters: isFiltersExpanded ? 'expanded' : 'collapsed',
      refresh: 'disabled',
    };
  }
  return {
    availability: 'available',
    filters: isFiltersExpanded ? 'expanded' : 'collapsed',
    refresh: 'ready',
  };
}

export function CompactToolbarActions({
  onRefresh,
  setFiltersExpanded,
  state,
}: {
  onRefresh: () => void;
  setFiltersExpanded: (expanded: boolean) => void;
  state: CompactToolbarActionsState;
}) {
  if (state.availability !== 'available') {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More Explorer actions"
          className="@[236px]/explorer-toolbar:hidden size-6"
          size="icon"
          variant="ghost"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={state.refresh !== 'ready'} onClick={() => onRefresh()}>
          <RefreshCw className={cn('size-4', state.refresh === 'refreshing' && 'animate-spin')} />
          Refresh file tree
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFiltersExpanded(state.filters === 'collapsed')}>
          <SlidersHorizontal className="size-4" />
          {state.filters === 'expanded' ? 'Hide view filters' : 'Show view filters'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Forest mode = more than one active root (sections render per root). */
export function isForestModeActive(rootDirectoryHandles: readonly unknown[] | undefined): boolean {
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
export const PanelTreeActionButtons = React.memo(
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
export const PanelFloatingTreeActions = ({
  hasRoot,
  isExpandingAll,
  isLoading,
  isRefreshing,
  isRestoring,
  onCollapseAll,
  onExpandAll,
}: {
  hasRoot: boolean;
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  /**
   * True while expanded-paths restoration runs. Both overlays pin to the tree
   * area's top band, so the cluster yields to RestorationStatus rather than
   * drawing over its right-aligned percentage readout.
   */
  isRestoring: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) => {
  if (!hasRoot || isRestoring) {
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
export function useForestExpandConfirm(forestActions: ForestTreeActionsValue | null): {
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
export async function runForestSelectAllSweep(args: {
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
export function resolveSelectAllWiring<T>(args: {
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
export function runFocusedTreeExpandAll(
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
