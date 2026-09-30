import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@brainstrike/ui';
import { ChevronDown, FolderGit2 } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { GitFolderMenu } from './git-folder-menu';

/** Orientation stays mounted through no-folder, loading, non-repo and error states. */
export function GitFocusedFolder(): ReactElement {
  const { rootDirectoryHandle } = useFileSystem();
  const [open, setOpen] = useState(false);

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-3 border-b bg-card/35 px-3 py-2"
      data-testid="git-focused-folder"
    >
      <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-xs">Focused folder</div>
        <div className="break-all text-muted-foreground text-xs" title={rootDirectoryHandle?.path}>
          {rootDirectoryHandle?.path ?? 'No folder focused'}
        </div>
      </div>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Switch repository or focused folder"
            size="sm"
            type="button"
            variant="outline"
          >
            Switch
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-96 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          {/* Discovery is mounted only by this explicit gesture, never by the Git panel. */}
          {open ? <GitFolderMenu /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
