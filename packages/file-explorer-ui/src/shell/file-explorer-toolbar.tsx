import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FileExplorerToolbarProps {
  bulkSelectionControl?: React.ReactNode;
  /**
   * Tree-grid column visibility. Revealed only at 300px, where the right track
   * first fits a FOURTH 28px control without breaking the documented
   * narrow-toolbar geometry — the same width below which the grid drops its
   * metadata columns entirely (see explorer-columns-context.ts).
   */
  columnsControl?: React.ReactNode;
  /**
   * Narrow-width menu for actions that cannot coexist with 24px targets and the
   * edge gutters. Renders nothing while an operation is cancellable, so the
   * scanning indicator's cancel gets the slot instead.
   */
  compactActionsControl?: React.ReactNode;
  /** Filter visibility toggle rendered between the tree actions and the right-edge bulk selection control. */
  filtersControl?: React.ReactNode;
  isLoading: boolean;
  onDirectorySelect: () => Promise<void>;
  selectionStatusControl?: React.ReactNode;
  /**
   * Tree operations (refresh) plus the inline scanning indicator, rendered in
   * the right cluster. They live on the toolbar — not inside the collapsible
   * filter block, and not inside the narrow-hidden wrapper — so the indicator's
   * cancel stays reachable at every panel width.
   */
  treeActionsControl?: React.ReactNode;
  /**
   * Expand All / Collapse All. Rendered in the LEFT track beside the selection
   * status, because the right track is exactly full at every documented width
   * step. Revealed at the same 236px step as Refresh and View Filters; below it
   * these fold into `compactActionsControl` (whole-branch review F11 — this
   * replaces the floating overlay that covered the tree grid's column header).
   */
  treeExpansionControl?: React.ReactNode;
}

const FileExplorerToolbar = React.memo(
  ({
    bulkSelectionControl,
    columnsControl,
    compactActionsControl,
    filtersControl,
    onDirectorySelect,
    isLoading,
    selectionStatusControl,
    treeActionsControl,
    treeExpansionControl,
  }: FileExplorerToolbarProps) => {
    // Multi-root: the add-folder action stays mathematically centered between the
    // selection controls. The label no longer flips on focus, and the focused-root
    // badge remains absent because it implied a single-root workspace.
    // data-testid="select-root-button" is intentionally kept (desktop E2E depends on it).
    // Container-query variants style descendants, so the measuring container
    // stays outside the grid. Edge padding lives inside each measured side slot
    // to preserve its disclosure breakpoints while keeping the gutters symmetric.
    return (
      <div className="@container/explorer-toolbar h-9 w-full max-w-full min-w-0 shrink-0 overflow-hidden border-b">
        <div
          className="grid h-full w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-0"
          data-testid="file-explorer-toolbar"
        >
          {/* overflow-hidden on BOTH side slots: each cluster is clipped to its
              own grid track, so an overwide cluster can never bleed across the
              centered add-folder button and intercept its pointer events (the
              unclickable-Add regression at narrow panel widths). */}
          <div className="@container/explorer-selection flex min-w-0 items-center justify-start overflow-hidden">
            {/* The left track is the toolbar's only cluster with slack: the
                right one is exactly full at 180/236/300px. Expand/Collapse
                therefore live HERE, and the selection counter yields to them
                below 180px of track (the mode badge still carries the compact
                count), so the two never fight for the same pixels. */}
            <div className="flex w-full min-w-0 items-center gap-1 pl-1 @[96px]/explorer-toolbar:pl-1.5 @[128px]/explorer-toolbar:pl-3">
              {selectionStatusControl}
              <div className="hidden @[236px]/explorer-toolbar:contents">
                {treeExpansionControl}
              </div>
            </div>
          </div>
          <Button
            aria-label={FileExplorerStrings.addFolderToWorkspace}
            className="border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/15 focus-visible:border-primary/70 focus-visible:ring-primary/30 size-6 p-0 shadow-sm hover:shadow-md motion-safe:transition-transform motion-safe:hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none @[96px]/explorer-toolbar:size-7 @[460px]/explorer-toolbar:w-auto @[460px]/explorer-toolbar:px-3"
            data-testid="select-root-button"
            disabled={isLoading}
            onClick={onDirectorySelect}
            size="icon-xs"
            variant="outline"
          >
            <Folder className="size-4 @[460px]/explorer-toolbar:mr-2" />
            <span className="hidden @[460px]/explorer-toolbar:inline">
              {FileExplorerStrings.addFolderToWorkspace}
            </span>
          </Button>
          <div className="@container/explorer-bulk flex min-w-0 items-center justify-end overflow-hidden">
            {/* At the 180px minimum panel width this track is exactly 76px.
                The compact menu and Select All preserve 24px targets plus the
                symmetric 12px edge gutter. At 236px, the full Refresh and View
                Filters actions replace the compact menu; three 28px controls,
                two 4px gaps, and the 12px gutter exactly fit the 104px track.
                Select All stays last so it remains the protected edge action.

                Tree actions sit OUTSIDE the narrow-hidden wrapper: the cluster
                carries the scanning indicator's Cancel (X), which is the only
                way to abort a running expand-all sweep, and hiding it wholesale
                at 180px left desktop users with no abort at all (BST-657
                regression). The cluster gates its own children instead — only
                the cancel survives the narrow track, and the compact menu
                yields its slot for the duration (see CompactToolbarActions). */}
            <div className="flex w-full min-w-0 items-center justify-end gap-0 pr-1 @[96px]/explorer-toolbar:pr-1.5 @[128px]/explorer-toolbar:pr-3 @[236px]/explorer-toolbar:gap-1">
              {/* Columns joins one breakpoint LATER than View Filters: at
                  236px the track holds exactly three 28px controls. */}
              <div className="hidden @[300px]/explorer-toolbar:contents">{columnsControl}</div>
              {/* NOT inside the narrow-hidden wrapper — BST-657: this cluster
                  carries the scanning indicator's Cancel, the only abort path
                  for a running sweep. It gates its own children by width. */}
              {treeActionsControl}
              <div className="hidden @[236px]/explorer-toolbar:contents">{filtersControl}</div>
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
