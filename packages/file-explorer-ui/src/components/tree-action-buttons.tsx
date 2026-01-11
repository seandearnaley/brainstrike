/**
 * Tree Action Buttons - Overlay buttons for expand/collapse/refresh actions.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 * Includes optional inline scanning status indicator that doesn't cause layout shift.
 */

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDown, ChevronsUp, Loader2, RefreshCw, X } from 'lucide-react';
import * as React from 'react';

export interface ScanningStatusInfo {
  isScanning: boolean;
  cancellable: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  currentPath?: string;
  percentage?: number;
}

interface TreeActionButtonsProps {
  isLoading: boolean;
  isRefreshing: boolean;
  isExpandingAll: boolean;
  onRefresh: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Optional scanning status for inline display */
  scanningStatus?: ScanningStatusInfo | null;
}

/**
 * Compact inline scanning indicator that shows progress without causing layout shift.
 */
const InlineScanningIndicator: React.FC<{
  status: ScanningStatusInfo;
}> = React.memo(({ status }) => {
  const { isCancelling, cancellable, onCancel, currentPath, percentage } = status;

  // Build compact status text
  const statusText = React.useMemo(() => {
    if (isCancelling) {
      return 'Stopping...';
    }
    if (percentage !== undefined && percentage > 0) {
      return `${percentage}%`;
    }
    return '';
  }, [isCancelling, percentage]);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1 shadow-sm backdrop-blur-sm',
        isCancelling && 'opacity-60'
      )}
      data-testid="inline-scanning-indicator"
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
      {statusText && (
        <span className="text-muted-foreground text-xs tabular-nums">{statusText}</span>
      )}
      {currentPath && !statusText && (
        <span className="max-w-[80px] truncate text-muted-foreground text-xs" title={currentPath}>
          Loading...
        </span>
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
      <div className="absolute top-2 right-6 z-20 flex items-center gap-1">
        {/* Inline scanning indicator - shown to the left of action buttons */}
        {scanningStatus?.isScanning && <InlineScanningIndicator status={scanningStatus} />}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Refresh"
              className="h-7 w-7 bg-background/80 shadow-sm backdrop-blur-sm"
              data-testid="refresh-button-small"
              disabled={refreshDisabled}
              onClick={onRefresh}
              size="icon"
              variant="ghost"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', { 'animate-spin': isRefreshing })} />
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
              className="h-7 w-7 bg-background/80 shadow-sm backdrop-blur-sm"
              data-testid="expand-all-button-small"
              disabled={expandDisabled}
              onClick={onExpandAll}
              size="icon"
              variant="ghost"
            >
              {isExpandingAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronsDown className="h-3.5 w-3.5" />
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
              className="h-7 w-7 bg-background/80 shadow-sm backdrop-blur-sm"
              data-testid="collapse-all-button-small"
              disabled={collapseDisabled}
              onClick={onCollapseAll}
              size="icon"
              variant="ghost"
            >
              <ChevronsUp className="h-3.5 w-3.5" />
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
