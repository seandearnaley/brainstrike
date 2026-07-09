/**
 * Tree Action Buttons - inline expand/collapse/refresh controls.
 *
 * Rendered in the file-explorer quick-filter row (via FileFilterBar's `trailing`
 * slot), next to the info button -- not as a floating overlay. Includes an
 * optional inline scanning status indicator placed *before* the fixed-width
 * buttons: it mounts immediately after the row's `flex-1 min-w-0` search input,
 * which absorbs the indicator's width (on mount and on digit growth), so the
 * action buttons keep their position rather than shifting. The only exception
 * is at the minimum panel width, where the input can no longer shrink.
 */

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDownUp, ChevronsUpDown, Loader2, RefreshCw, X } from 'lucide-react';
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
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
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
 * Inline buttons for tree expand/collapse/refresh actions.
 * Includes optional inline scanning indicator.
 */
export const TreeActionButtons = React.memo(
  ({
    isLoading,
    isRefreshing,
    isExpandingAll,
    onRefresh,
    onExpandAll,
    onCollapseAll,
    scanningStatus,
  }: TreeActionButtonsProps) => {
    const refreshDisabled = isLoading || isRefreshing;
    const expandDisabled = isLoading || isRefreshing || isExpandingAll;
    const collapseDisabled = isLoading || isRefreshing;

    const expandLabel = isExpandingAll ? 'Expanding...' : 'Expand All';
    const expandTooltip = isExpandingAll ? 'Expanding directories...' : 'Expand all directories';

    return (
      <div className="flex shrink-0 items-center gap-1">
        {/* Inline scanning indicator - shown to the left of action buttons.
            Placed before the (fixed-width) buttons so the filter row's flexible
            search input absorbs its width, keeping the buttons from shifting.
            Hide ONLY the indicator's spinner when an adjacent button is already
            spinning (Refresh while isRefreshing, Expand-all while
            isExpandingAll) -- two spinning circles in one row is the redundancy
            this row removes. We never hide the whole indicator: the count is
            the progress signal during expand, and the cancel X is the user's
            only way to abort a slow/stuck reload (the Refresh button is
            disabled). During a plain first load nothing else spins, so the
            indicator's own spinner stays visible as the sole activity cue. */}
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
              className="h-8 w-8"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={expandLabel}
              className="h-8 w-8"
              data-testid="expand-all-button-small"
              disabled={expandDisabled}
              onClick={onExpandAll}
              size="icon"
              variant="ghost"
            >
              {isExpandingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronsUpDown className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{expandTooltip}</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Collapse All"
              className="h-8 w-8"
              data-testid="collapse-all-button-small"
              disabled={collapseDisabled}
              onClick={onCollapseAll}
              size="icon"
              variant="ghost"
            >
              <ChevronsDownUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Collapse all directories</p>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }
);

TreeActionButtons.displayName = 'TreeActionButtons';
