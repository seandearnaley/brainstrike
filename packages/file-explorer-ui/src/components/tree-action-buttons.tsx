/**
 * Tree Action Buttons - the toolbar's refresh control + scanning indicator.
 *
 * Rendered in the file-explorer toolbar's right cluster (not inside the
 * collapsible view-filters block) so it stays reachable while filters are
 * collapsed. Button sizes follow the toolbar's container-query steps to match
 * their siblings; outside that container the base size applies. Includes an
 * optional inline scanning status indicator placed ahead of the fixed-width
 * button: the cluster is right-justified with a flexible column to its left,
 * which absorbs the indicator's width (on mount and on digit growth), so the
 * refresh button keeps its position rather than shifting.
 *
 * Expand All / Collapse All moved to the FloatingTreeActions overlay pinned
 * over the tree area (BST-571) — the toolbar cluster was overcrowded. Refresh
 * stays HERE because its disabled/spin state pairs with the indicator's
 * cancel affordance. `isExpandingAll` is still consumed to suppress the
 * indicator's redundant spinner while the floating expand button spins.
 */

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Loader2, RefreshCw, X } from 'lucide-react';
import * as React from 'react';

export interface ScanningStatusInfo {
  cancellable: boolean;
  currentPath?: string;
  isCancelling: boolean;
  isScanning: boolean;
  /** Monotonic count of directories processed so far (steady growth, no flashing). */
  loadedCount?: number;
  onCancel: () => void;
  /** Best-known total directory count (may grow as discovery continues). */
  totalCount?: number;
}

interface TreeActionButtonsProps {
  /**
   * True while an expand-all sweep runs. The buttons live in the floating
   * cluster now, but the indicator still suppresses its own spinner while
   * the floating expand button spins (one spinning circle per operation).
   */
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  /** Optional scanning status for inline display */
  scanningStatus?: ScanningStatusInfo | null;
}

/**
 * Compact inline scanning indicator that shows progress without causing layout shift.
 */
const InlineScanningIndicator = React.memo(
  ({
    status,
    hideSpinner = false,
  }: {
    /**
     * Hide the indicator's own spinner. During a refresh the Refresh button
     * already spins, so a second spinner here just crowds the filter row -- but
     * the underlying load is still `cancellable`, so the Cancel (X) affordance
     * must remain reachable (the Refresh button is disabled and can't double as
     * a cancel). We drop only the redundant spinner, never the cancel button.
     */
    hideSpinner?: boolean;
    status: ScanningStatusInfo;
  }) => {
    const { isCancelling, cancellable, onCancel, currentPath, loadedCount, totalCount } = status;

    // Prefer a raw, monotonic directory count over a percentage. `totalCount`
    // grows as lazy subfolders are discovered, so a `loaded/total` percentage is
    // non-monotonic and visually flashes; `loadedCount` only ever increases, so a
    // bare count reads as steady growth. `tabular-nums` keeps digit width fixed.
    const countText = React.useMemo(() => {
      if (loadedCount === undefined) {
        return '';
      }
      return totalCount === undefined ? `${loadedCount}` : `${loadedCount}/${totalCount}`;
    }, [loadedCount, totalCount]);

    // With the spinner hidden, no count, no cancelling label, and not cancellable
    // (e.g. a non-cancellable refresh), there is nothing to paint -- avoid an
    // empty, zero-size div that could flake a future toBeVisible() assertion.
    const hasVisibleContent = !hideSpinner || isCancelling || Boolean(countText) || cancellable;
    if (!hasVisibleContent) {
      return null;
    }

    return (
      <div
        className={cn('flex items-center gap-1.5', isCancelling && 'opacity-60')}
        data-testid="inline-scanning-indicator"
      >
        {!hideSpinner && (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
            data-testid="inline-scanning-spinner"
          />
        )}
        {isCancelling ? (
          <span className="text-muted-foreground text-xs">Stopping...</span>
        ) : (
          countText && (
            <span
              className="text-muted-foreground text-xs tabular-nums"
              data-testid="inline-scanning-count"
              title={currentPath}
            >
              {countText}
            </span>
          )
        )}
        {cancellable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={isCancelling ? 'Cancelling' : 'Cancel operation'}
                className="h-5 w-5 shrink-0"
                disabled={isCancelling}
                onClick={onCancel}
                size="icon"
                variant="ghost"
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{isCancelling ? 'Cancelling...' : 'Cancel operation'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }
);

InlineScanningIndicator.displayName = 'InlineScanningIndicator';

/**
 * Toolbar refresh button plus the optional inline scanning indicator.
 */
export const TreeActionButtons = React.memo(
  ({
    isLoading,
    isRefreshing,
    isExpandingAll,
    onRefresh,
    scanningStatus,
  }: TreeActionButtonsProps) => {
    const refreshDisabled = isLoading || isRefreshing;

    return (
      <div className="flex shrink-0 items-center gap-1">
        {/* Inline scanning indicator - shown to the left of the refresh
            button. Placed before the (fixed-width) button so the right
            cluster's flexible column absorbs its width, keeping the button
            from shifting. Hide ONLY the indicator's spinner when another
            control is already spinning (Refresh while isRefreshing, the
            floating expand-all button while isExpandingAll) -- two spinning
            circles for one operation is the redundancy this removes. We never
            hide the whole indicator: the count is the progress signal during
            expand, and the cancel X is the user's only way to abort a
            slow/stuck reload (the Refresh button is disabled). During a plain
            first load nothing else spins, so the indicator's own spinner
            stays visible as the sole activity cue. */}
        {scanningStatus?.isScanning && (
          <InlineScanningIndicator
            hideSpinner={isRefreshing || isExpandingAll}
            status={scanningStatus}
          />
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Refresh"
              className="@[96px]/explorer-toolbar:size-7 size-6"
              data-testid="refresh-button-small"
              disabled={refreshDisabled}
              onClick={onRefresh}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={cn('h-4 w-4', { 'animate-spin': isRefreshing })} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Refresh file tree</p>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }
);

TreeActionButtons.displayName = 'TreeActionButtons';
