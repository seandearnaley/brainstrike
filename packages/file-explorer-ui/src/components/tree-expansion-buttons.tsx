/**
 * Expand All / Collapse All — a TOOLBAR cluster (BST-1208, whole-branch review
 * F11).
 *
 * These lived in a floating overlay pinned over the tree area's top-right
 * corner (BST-571), on the premise that the corner was empty. BST-1208 put the
 * tree grid's column header there: at the Explorer's normal width the overlay
 * covered the trailing metadata header and INTERCEPTED its clicks, so "click a
 * column to sort" was unreachable by ordinary pointer use. The overlay is
 * retired rather than repositioned — its whole cost (absolute positioning, the
 * never-shift-rows contract, the yield-to-RestorationStatus rule) existed only
 * because it floated over the tree.
 *
 * They sit in the toolbar's LEFT track, which is the one cluster with real
 * slack: the right track is exactly full at every documented width step
 * (see `docs/agents/explorer-search-context-map.md`). They reuse the toolbar's
 * EXISTING 236px step — below it they fold into the compact "More Explorer
 * actions" menu that is already there, so no new breakpoint is introduced.
 *
 * Keeps the historical `expand-all-button-small` / `collapse-all-button-small`
 * testids — every web/desktop e2e spec drives these actions by id.
 */

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { ChevronsDownUp, ChevronsUpDown, Loader2 } from 'lucide-react';
import * as React from 'react';
import { resolveTreeExpansionDisabledState } from '../utils/tree-expansion-disabled-state';

interface TreeExpansionButtonsProps {
  isExpandingAll: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}

export const TreeExpansionButtons = React.memo(
  ({
    isExpandingAll,
    isLoading,
    isRefreshing,
    onCollapseAll,
    onExpandAll,
  }: TreeExpansionButtonsProps) => {
    const disabled = resolveTreeExpansionDisabledState({ isExpandingAll, isLoading, isRefreshing });
    const expandLabel = isExpandingAll ? 'Expanding...' : 'Expand All';
    const expandTooltip = isExpandingAll ? 'Expanding directories...' : 'Expand all directories';

    return (
      <div className="flex shrink-0 items-center gap-0.5" data-testid="tree-expansion-actions">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={expandLabel}
              className="@[236px]/explorer-toolbar:size-7 size-6"
              data-testid="expand-all-button-small"
              disabled={disabled.expand}
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
              className="@[236px]/explorer-toolbar:size-7 size-6"
              data-testid="collapse-all-button-small"
              disabled={disabled.collapse}
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

TreeExpansionButtons.displayName = 'TreeExpansionButtons';
