import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FileExplorerToolbarProps {
  bulkSelectionControl?: React.ReactNode;
  /** Narrow-width menu for actions that cannot coexist with 24px targets and the edge gutters. */
  compactActionsControl?: React.ReactNode;
  /** Filter visibility toggle rendered between the tree actions and the right-edge bulk selection control. */
  filtersControl?: React.ReactNode;
  isLoading: boolean;
  onDirectorySelect: () => Promise<void>;
  selectionStatusControl?: React.ReactNode;
  /**
   * Tree operations (refresh / expand / collapse) rendered in the right
   * cluster. They live on the toolbar — not inside the collapsible filter
   * block — so they stay reachable while view filters are collapsed.
   */
  treeActionsControl?: React.ReactNode;
}

const FileExplorerToolbar = React.memo(
  ({
    bulkSelectionControl,
    compactActionsControl,
    filtersControl,
    onDirectorySelect,
    isLoading,
    selectionStatusControl,
    treeActionsControl,
  }: FileExplorerToolbarProps) => {
    // Multi-root: the add-folder action stays mathematically centered between the
    // selection controls. The label no longer flips on focus, and the focused-root
    // badge remains absent because it implied a single-root workspace.
    // data-testid="select-root-button" is intentionally kept (desktop E2E depends on it).
    // Container-query variants style descendants, so the measuring container
    // stays outside the grid. Edge padding lives inside each measured side slot
    // to preserve its disclosure breakpoints while keeping the gutters symmetric.
    return (
      <div className="@container/explorer-toolbar h-9 w-full min-w-0 max-w-full shrink-0 overflow-hidden border-b">
        <div
          className="grid h-full w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-0"
          data-testid="file-explorer-toolbar"
        >
          {/* overflow-hidden on BOTH side slots: each cluster is clipped to its
              own grid track, so an overwide cluster can never bleed across the
              centered add-folder button and intercept its pointer events (the
              unclickable-Add regression at narrow panel widths). */}
          <div className="@container/explorer-selection flex min-w-0 items-center justify-start overflow-hidden">
            <div className="flex w-full min-w-0 items-center justify-start @[128px]/explorer-toolbar:pl-3 @[96px]/explorer-toolbar:pl-1.5 pl-1">
              {selectionStatusControl}
            </div>
          </div>
          <Button
            aria-label={FileExplorerStrings.addFolderToWorkspace}
            className="@[96px]/explorer-toolbar:size-7 size-6 @[460px]/explorer-toolbar:w-auto border-primary/40 bg-primary/10 p-0 @[460px]/explorer-toolbar:px-3 text-primary shadow-sm hover:border-primary/60 hover:bg-primary/15 hover:shadow-md focus-visible:border-primary/70 focus-visible:ring-primary/30 motion-safe:transition-transform motion-safe:hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none"
            data-testid="select-root-button"
            disabled={isLoading}
            onClick={onDirectorySelect}
            size="icon-xs"
            variant="outline"
          >
            <Folder className="@[460px]/explorer-toolbar:mr-2 size-4" />
            <span className="@[460px]/explorer-toolbar:inline hidden">
              {FileExplorerStrings.addFolderToWorkspace}
            </span>
          </Button>
          <div className="@container/explorer-bulk flex min-w-0 items-center justify-end overflow-hidden">
            {/* At the 180px minimum panel width this track is exactly 76px.
                The compact menu and Select All preserve 24px targets plus the
                symmetric 12px edge gutter. At 236px, the full Refresh and View
                Filters actions replace the compact menu; three 28px controls,
                two 4px gaps, and the 12px gutter exactly fit the 104px track.
                Select All stays last so it remains the protected edge action. */}
            <div className="flex w-full min-w-0 items-center justify-end @[236px]/explorer-toolbar:gap-1 gap-0 @[128px]/explorer-toolbar:pr-3 @[96px]/explorer-toolbar:pr-1.5 pr-1">
              <div className="@[236px]/explorer-toolbar:contents hidden">
                {treeActionsControl}
                {filtersControl}
              </div>
              {compactActionsControl}
              {bulkSelectionControl}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
