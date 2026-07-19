/**
 * Floating Expand All / Collapse All cluster (BST-571).
 *
 * Pinned to the top-right of the explorer tree area as an overlay — the
 * toolbar's right cluster was overcrowded, and this corner of the tree is
 * usually empty. Mounting/unmounting must never shift tree rows (same
 * contract as the RestorationStatus overlay in file-explorer-panel.tsx).
 * Refresh and the inline scanning indicator deliberately stay on the toolbar:
 * refresh pairs with the scanning indicator's cancel affordance.
 *
 * Keeps the historical `expand-all-button-small` / `collapse-all-button-small`
 * testids — every web/desktop e2e spec drives these actions by id.
 */

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDownUp, ChevronsUpDown, Loader2 } from 'lucide-react';
import * as React from 'react';

interface FloatingTreeActionsProps {
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

export const FloatingTreeActions = React.memo(
  ({
    isExpandingAll,
    isLoading,
    isRefreshing,
    onCollapseAll,
    onExpandAll,
  }: FloatingTreeActionsProps) => {
    const expandDisabled = isLoading || isRefreshing || isExpandingAll;
    // Collapse stays enabled while expanding — it doubles as the stop
    // affordance (the panel's collapseAll cancels the running sweep first).
    const collapseDisabled = isLoading || isRefreshing;

    const expandLabel = isExpandingAll ? 'Expanding...' : 'Expand All';
    const expandTooltip = isExpandingAll ? 'Expanding directories...' : 'Expand all directories';

    return (
      <div
        className="absolute top-2 right-2 z-20 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/85 p-0.5 shadow-sm backdrop-blur-sm"
        data-testid="floating-tree-actions"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={expandLabel}
              className="size-6"
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
          <TooltipContent side="bottom">
            <p>{expandTooltip}</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Collapse All"
              className="size-6"
              data-testid="collapse-all-button-small"
              disabled={collapseDisabled}
              onClick={onCollapseAll}
              size="icon"
              variant="ghost"
            >
              <ChevronsDownUp className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Collapse all directories</p>
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }
);

FloatingTreeActions.displayName = 'FloatingTreeActions';
