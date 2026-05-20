import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import * as React from 'react';
import { FolderBadge } from '../folder-badge';

interface FileExplorerToolbarProps {
  isLoading: boolean;
  onDirectorySelect: () => Promise<void>;
  rootDirectoryHandle: DirectoryHandle | null;
}

const FileExplorerToolbar: React.FC<FileExplorerToolbarProps> = React.memo(
  ({ onDirectorySelect, isLoading, rootDirectoryHandle }) => (
    <div
      className="@container flex items-center justify-between gap-2 border-b px-2 py-2"
      data-testid="file-explorer-toolbar"
    >
      <Button
        aria-label={FileExplorerStrings.selectRoot}
        className="@[300px]:h-9 h-8 @[300px]:px-3 px-2"
        data-testid="select-root-button"
        disabled={isLoading}
        onClick={onDirectorySelect}
        size="sm"
        variant="outline"
      >
        <Folder className="@[300px]:mr-2 size-4" />
        <span className="@[300px]:inline hidden">{FileExplorerStrings.selectRoot}</span>
      </Button>
      {rootDirectoryHandle ? (
        <FolderBadge className="max-w-[calc(100%-3rem)]" folderId={rootDirectoryHandle.name} />
      ) : null}
    </div>
  )
);

FileExplorerToolbar.displayName = 'FileExplorerToolbar';

export { FileExplorerToolbar };
