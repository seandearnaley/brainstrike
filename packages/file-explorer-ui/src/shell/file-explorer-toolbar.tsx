import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FileExplorerToolbarProps {
  isLoading: boolean;
  onDirectorySelect: () => Promise<void>;
}

const FileExplorerToolbar = React.memo(
  ({ onDirectorySelect, isLoading }: FileExplorerToolbarProps) => {
    // Multi-root: one consolidated, centered action. The label no longer flips on
    // focus, and the focused-root folder badge was removed (it implied a single
    // active root, which no longer reflects the workspace model).
    // data-testid="select-root-button" is intentionally kept (desktop E2E depends on it).
    return (
      <div
        className="@container flex items-center justify-center gap-2 border-b px-2 py-2"
        data-testid="file-explorer-toolbar"
      >
        <Button
          aria-label={FileExplorerStrings.addFolderToWorkspace}
          className="@[300px]:h-9 h-8 @[300px]:px-3 px-2"
          data-testid="select-root-button"
          disabled={isLoading}
          onClick={onDirectorySelect}
          size="sm"
          variant="outline"
        >
          <Folder className="@[300px]:mr-2 size-4" />
          <span className="@[300px]:inline hidden">{FileExplorerStrings.addFolderToWorkspace}</span>
        </Button>
      </div>
    );
  }
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
