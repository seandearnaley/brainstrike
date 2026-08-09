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
import { Eye, EyeOff, MoreHorizontal, RefreshCw, SlidersHorizontal } from 'lucide-react';
import * as React from 'react';
import { useMemo } from 'react';
import { FloatingTreeActions } from '../components/floating-tree-actions';
import { TreeActionButtons } from '../components/tree-action-buttons';
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

export function CompactToolbarActions({
  onRefresh,
  setFiltersExpanded,
  state,
}: {
  onRefresh: () => void;
  setFiltersExpanded: (expanded: boolean) => void;
  state: CompactToolbarActionsState;
}) {
  if (state.availability === 'unavailable') {
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
