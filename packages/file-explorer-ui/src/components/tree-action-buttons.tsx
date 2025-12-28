/**
 * Tree Action Buttons - Overlay buttons for expand/collapse/refresh actions.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 */

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDown, ChevronsUp, Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';

type TreeActionButtonsProps = {
  isLoading: boolean;
  isRefreshing: boolean;
  isExpandingAll: boolean;
  onRefresh: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
};

/**
 * Overlay buttons for tree expand/collapse/refresh actions.
 */
export const TreeActionButtons: React.FC<TreeActionButtonsProps> = React.memo(
  ({ isLoading, isRefreshing, isExpandingAll, onRefresh, onExpandAll, onCollapseAll }) => {
    const refreshDisabled = isLoading || isRefreshing;
    const expandDisabled = isLoading || isRefreshing || isExpandingAll;
    const collapseDisabled = isLoading || isRefreshing;

    const expandLabel = isExpandingAll ? 'Expanding...' : 'Expand All';
    const expandTooltip = isExpandingAll ? 'Expanding directories...' : 'Expand all directories';

    return (
      <div className="absolute top-2 right-6 z-20 flex items-center gap-1">
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
