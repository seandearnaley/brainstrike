import { Folder } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * A delegated child's workspace: the folder it shares with its root thread.
 * The root owns the folder, so the chip only names it, with no menu to add or
 * change one. The folder chip's shape, without its trigger.
 */
export const SharedFolderChip = ({
  displayName,
  path,
}: {
  /** The root's folder; absent while the root has none and tools pick an open one. */
  readonly displayName: string | undefined;
  readonly path?: string | undefined;
}): ReactElement => (
  <span
    className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground"
    data-testid="workspace-bar-shared-folder"
    {...(path ? { title: path } : {})}
  >
    <Folder aria-hidden="true" className="size-3 shrink-0" />
    <span className="sr-only">Shared workspace: </span>
    <span className="truncate">{displayName ?? 'tools select an open folder'}</span>
  </span>
);
