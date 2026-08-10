/**
 * Pure toolbar logic for the Explorer panel.
 *
 * Split out of file-explorer-panel-toolbar-helpers.tsx so that module exports
 * ONLY components: Vite's React Fast Refresh plugin treats a module as a
 * refresh boundary only when every one of its exports is a component, so a
 * single plain-function export there forces a full reload of the panel on
 * every edit. Nothing in here renders — keep it JSX-free.
 */

import { createLogger } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { resolveTreeExpansionDisabledState } from '../utils/tree-expansion-disabled-state';
import type { useFileExplorerStoreContext } from './file-explorer-provider';
import type { useOptionalForestTreeActions } from './forest-tree-actions-context';

// Same scope as file-explorer-panel.tsx on purpose: createLogger caches by scope, so both modules share one logger instance.
const logger = createLogger('FileExplorerPanel');

type CompactRefreshState = 'disabled' | 'ready' | 'refreshing';
type CompactViewFiltersState = 'collapsed' | 'expanded';
interface CompactExpansionState {
  collapseDisabled: boolean;
  expandDisabled: boolean;
}
export type CompactToolbarActionsState =
  | { availability: 'unavailable' }
  | { availability: 'yielded-to-cancel' }
  | {
      availability: 'available';
      expansion: CompactExpansionState;
      filters: CompactViewFiltersState;
      refresh: CompactRefreshState;
    };

/**
 * True while the toolbar's scanning indicator — and therefore its cancel — is
 * on screen. This is the signal that makes the compact menu yield the narrow
 * track, so it must be EXACTLY the indicator's own visibility rule: a state
 * where this returns true but no cancel renders would leave the 180px track
 * holding Select All and nothing else — a worse version of the bug BST-657
 * fixed.
 *
 * The `isForestExpandingAll && forestCancelExpandAll` pairing is deliberate,
 * not redundant: resolveExpandAllScanningSource falls through to the focused
 * provider when the forest cancel is null, and that provider is idle during a
 * forest sweep, so computeScanningStatusProps would return null. Threading the
 * cancel through keeps the two rules identical by construction rather than by
 * the two forest contexts happening to ship from the same provider.
 *
 * Run-boundary only: it flips once per operation, never per progress frame, so
 * reading it in the panel does not defeat the PanelTreeActionButtons leaf.
 */
export function isCancellableOperationRunning(args: {
  forestCancelExpandAll: (() => void) | null;
  isExpandingAll: boolean;
  isForestExpandingAll: boolean;
  loadingProgress: { isInitialLoading?: boolean } | null | undefined;
}): boolean {
  return (
    Boolean(args.loadingProgress?.isInitialLoading) ||
    args.isExpandingAll ||
    (args.isForestExpandingAll && args.forestCancelExpandAll !== null)
  );
}

interface CompactToolbarActionsInput {
  hasRoot: boolean;
  /**
   * Feeds the SHARED expansion disabled rule below, so the menu's Expand /
   * Collapse items and their toolbar-button counterparts can never disagree.
   */
  isExpandingAll: boolean;
  isFiltersExpanded: boolean;
  isLoading: boolean;
  /**
   * True while a cancellable operation is running. The 76px narrow track fits
   * two 24px controls beside the 12px gutter, and during an operation the
   * second one must be the scanning indicator's cancel — the compact menu's
   * Refresh item is disabled anyway, and the cancel has no other route.
   *
   * Read the cost honestly: this is NOT only "the few seconds a sweep takes".
   * `isInitialLoading` is `isLoading && loadingPaths.size === 0`, so it holds
   * for a whole first workspace scan and for the whole body of handleRefresh —
   * below 236px the compact menu is the only route to View Filters, so that
   * toggle is unreachable for the length of a cold scan and blinks out on
   * every refresh. Scoping the yield to expand-all only would not fix it: at
   * 180px an initial load would then paint cancel + menu + Select All = 80px
   * into a 76px track and clip, which is precisely the overlap BST-657 fixed.
   * Losing a filter toggle while an operation runs beats an unclickable
   * control, so the yield stays broad.
   *
   * Note refresh is covered INCIDENTALLY, via isInitialLoading — neither this
   * flag nor isCancellableOperationRunning reads `isRefreshing`.
   */
  isOperationInProgress: boolean;
  isRefreshing: boolean;
}

export function resolveCompactToolbarActionsState({
  hasRoot,
  isExpandingAll,
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
  // ONE disabled rule for both surfaces: the menu below 236px and the buttons
  // above it must never disagree about whether an action is available.
  const disabled = resolveTreeExpansionDisabledState({ isExpandingAll, isLoading, isRefreshing });
  const expansion: CompactExpansionState = {
    collapseDisabled: disabled.collapse,
    expandDisabled: disabled.expand,
  };
  if (isRefreshing) {
    return {
      availability: 'available',
      expansion,
      filters: isFiltersExpanded ? 'expanded' : 'collapsed',
      refresh: 'refreshing',
    };
  }
  if (isLoading) {
    return {
      availability: 'available',
      expansion,
      filters: isFiltersExpanded ? 'expanded' : 'collapsed',
      refresh: 'disabled',
    };
  }
  return {
    availability: 'available',
    expansion,
    filters: isFiltersExpanded ? 'expanded' : 'collapsed',
    refresh: 'ready',
  };
}

/** Forest mode = more than one active root (sections render per root). */
export function isForestModeActive(rootDirectoryHandles: readonly unknown[] | undefined): boolean {
  return (rootDirectoryHandles?.length ?? 0) > 1;
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
