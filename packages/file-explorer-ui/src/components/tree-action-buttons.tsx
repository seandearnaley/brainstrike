/**
 * Tree Action Buttons - Overlay buttons for expand/collapse/refresh actions.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 * Includes optional inline scanning status indicator that doesn't cause layout shift.
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
const InlineScanningIndicator: React.FC<{
  status: ScanningStatusInfo;
}> = React.memo(({ status }) => {
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

  return (
    <div
      className={cn('flex items-center gap-1.5', isCancelling && 'opacity-60')}
      data-testid="inline-scanning-indicator"
      title={currentPath}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      {isCancelling ? (
        <span className="text-muted-foreground text-xs">Stopping...</span>
      ) : (
        countText && (
          <span
            className="text-right text-muted-foreground text-xs tabular-nums"
            data-testid="inline-scanning-count"
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
});

InlineScanningIndicator.displayName = 'InlineScanningIndicator';

/**
 * Overlay buttons for tree expand/collapse/refresh actions.
 * Includes optional inline scanning indicator.
 */
export const TreeActionButtons: React.FC<TreeActionButtonsProps> = React.memo(
  ({
    isLoading,
    isRefreshing,
    isExpandingAll,
    onRefresh,
    onExpandAll,
    onCollapseAll,
    scanningStatus,
  }) => {
    const refreshDisabled = isLoading || isRefreshing;
    const expandDisabled = isLoading || isRefreshing || isExpandingAll;
    const collapseDisabled = isLoading || isRefreshing;

    const expandLabel = isExpandingAll ? 'Expanding...' : 'Expand All';
    const expandTooltip = isExpandingAll ? 'Expanding directories...' : 'Expand all directories';

    return (
      <div className="flex shrink-0 items-center gap-1">
        {/* Inline scanning indicator - shown to the left of action buttons.
            Placed before the (fixed-width) buttons so the filter row's flexible
            search input absorbs its width, keeping the buttons from shifting. */}
        {scanningStatus?.isScanning && <InlineScanningIndicator status={scanningStatus} />}

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
