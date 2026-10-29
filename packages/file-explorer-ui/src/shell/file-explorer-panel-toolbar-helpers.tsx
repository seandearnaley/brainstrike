/**
 * Explorer panel toolbar COMPONENTS.
 *
 * Every export here must be a component: Vite's React Fast Refresh plugin keeps
 * a module as a refresh boundary only while each export either looks like a
 * component or keeps its identity across the edit — and re-evaluating the
 * module always gives an exported function a fresh identity, so one plain
 * function or hook export costs the whole panel a full reload on every edit.
 * Pure logic belongs in file-explorer-panel-toolbar-logic.ts, hooks in their
 * own `use-*.ts` module. Exception: the check only walks a module's EXPORTS, so
 * private logic (resolveExpandAllScanningSource) may stay here rather than be
 * widened to a public export with no second consumer.
 */

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
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  MoreHorizontal,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import * as React from 'react';
import { useMemo } from 'react';
import { TreeActionButtons } from '../components/tree-action-buttons';
import { TreeExpansionButtons } from '../components/tree-expansion-buttons';
import { computeScanningStatusProps } from '../utils/scanning-status-props';
import type { CompactToolbarActionsState } from './file-explorer-panel-toolbar-logic';
import { type ExpandAllProgress, useForestExpandAllProgress } from './forest-tree-actions-context';

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
          className="h-8 w-8 shrink-0 @[300px]:h-9 @[300px]:w-9"
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
            'relative size-6 shrink-0 p-0 @[236px]/explorer-toolbar:size-7',
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
              className="bg-primary absolute top-0.5 right-0.5 size-1.5 rounded-full"
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

/**
 * Narrow-width home for the toolbar actions that have no room as buttons.
 *
 * Below 236px the right track is 76px — two 24px controls and the symmetric
 * 12px gutters — so Refresh, View Filters AND the tree expansion actions fold
 * in here. This is the SAME breakpoint the expansion buttons and the
 * Refresh/View-Filters buttons appear at, so every action has exactly one home
 * at every width (whole-branch review F11: the floating overlay that used to
 * host expand/collapse at all widths is gone).
 */
export function CompactToolbarActions({
  onCollapseAll,
  onExpandAll,
  onRefresh,
  setFiltersExpanded,
  state,
}: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
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
          className="size-6 @[236px]/explorer-toolbar:hidden"
          size="icon"
          variant="ghost"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid="expand-all-menu-item"
          disabled={state.expansion.expandDisabled}
          onClick={() => onExpandAll()}
        >
          <ChevronsUpDown className="size-4" />
          Expand all directories
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="collapse-all-menu-item"
          disabled={state.expansion.collapseDisabled}
          onClick={() => onCollapseAll()}
        >
          <ChevronsDownUp className="size-4" />
          Collapse all directories
        </DropdownMenuItem>
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
 * Mounts the toolbar's Expand/Collapse All cluster once a workspace root exists
 * (same gate as the toolbar's other tree actions). Kept as its own leaf so the
 * gating branch lives outside the panel body.
 *
 * No `isRestoring` gate any more: that existed only because the floating
 * overlay and RestorationStatus fought for the tree area's top band. In the
 * toolbar nothing overlaps, and hiding the cancel-adjacent actions mid-restore
 * was itself a small trap.
 */
export const PanelTreeExpansionButtons = ({
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
    <TreeExpansionButtons
      isExpandingAll={isExpandingAll}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      onCollapseAll={onCollapseAll}
      onExpandAll={onExpandAll}
    />
  );
};
