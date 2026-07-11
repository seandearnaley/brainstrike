import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FileExplorerToolbarProps {
  bulkSelectionControl?: React.ReactNode;
  isLoading: boolean;
  onDirectorySelect: () => Promise<void>;
  selectionStatusControl?: React.ReactNode;
}

const FileExplorerToolbar = React.memo(
  ({
    bulkSelectionControl,
    onDirectorySelect,
    isLoading,
    selectionStatusControl,
  }: FileExplorerToolbarProps) => {
    // Multi-root: the add-folder action stays mathematically centered between the
    // selection controls. The label no longer flips on focus, and the focused-root
    // badge remains absent because it implied a single-root workspace.
    // data-testid="select-root-button" is intentionally kept (desktop E2E depends on it).
    return (
      <div
        className="@container/explorer-toolbar grid h-12 w-full min-w-0 max-w-full shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center @[128px]:gap-1.5 @[96px]:gap-0.5 gap-0 overflow-hidden border-b @[128px]:px-2 @[96px]:px-0.5 px-0"
        data-testid="file-explorer-toolbar"
      >
        <div className="@container/explorer-bulk flex min-w-0 items-center justify-end">
          {bulkSelectionControl}
        </div>
        <Button
          aria-label={FileExplorerStrings.addFolderToWorkspace}
          className="@[128px]:size-8 @[96px]:size-7 size-6 @[460px]:w-auto border-primary/40 bg-primary/10 p-0 @[460px]:px-3 text-primary shadow-sm hover:border-primary/60 hover:bg-primary/15 hover:shadow-md focus-visible:border-primary/70 focus-visible:ring-primary/30 motion-safe:transition-transform motion-safe:hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none"
          data-testid="select-root-button"
          disabled={isLoading}
          onClick={onDirectorySelect}
          size="icon-xs"
          variant="outline"
        >
          <Folder className="@[460px]:mr-2 size-4" />
          <span className="@[460px]:inline hidden">{FileExplorerStrings.addFolderToWorkspace}</span>
        </Button>
        <div className="@container/explorer-selection flex min-w-0 items-center justify-start">
          {selectionStatusControl}
        </div>
      </div>
    );
  }
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
