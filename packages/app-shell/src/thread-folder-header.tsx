/**
 * Section header for the Threads panel's `groupBy: 'folder'` view (BST-1405).
 *
 * Deliberately NOT `ThreadGroupHeader` with a different icon. A custom group is
 * a durable object the user creates, renames, colors, reorders and drops
 * threads into; a folder section is a VIEW over the folder each thread already
 * works in (`metadata.operatingRootId`). So this header carries no rename, no
 * appearance, no delete and no drop target — only the folder's identity, its
 * live count, and the one action that belongs to a folder: start a thread in
 * it. Re-binding an EXISTING thread stays where the binding is made, the
 * composer's folder chip, and the header says so in its tooltip.
 */
import type { ThreadFolderRow } from '@brainstrike/assistant-data';
import { Button } from '@brainstrike/ui';
import { Folder, FolderX, Plus } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * Why the header offers no way to move a thread between folders. Rendered as
 * the section's tooltip so the missing drag target reads as a rule rather than
 * a gap.
 */
export const THREAD_FOLDER_GROUPING_HINT =
  "Grouped by the thread's primary folder — change it from the composer's folder chip.";

export function ThreadFolderHeader({
  folder,
  onNewThreadHere,
  threadCount,
}: {
  /** `null` renders the trailing "No folder" section. */
  readonly folder: ThreadFolderRow | null;
  /** `null` while no repository is ready to create a thread. */
  readonly onNewThreadHere: ((folder: ThreadFolderRow) => void) | null;
  readonly threadCount: number;
}): ReactElement {
  const displayName = folder?.displayName ?? 'No folder';
  return (
    <div className="min-w-0" data-testid="thread-folder-header" title={THREAD_FOLDER_GROUPING_HINT}>
      <div className="flex min-h-10 min-w-0 items-center gap-2 px-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/55 text-muted-foreground"
          data-testid={folder ? 'thread-folder-icon' : 'thread-folder-unassigned-icon'}
        >
          {folder ? <Folder className="size-3.5" /> : <FolderX className="size-3.5" />}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-medium text-[13px] leading-4"
          // The path, when the root has one: a display name is not an identity
          // and two roots can share it. FSA roots have no path and get none.
          title={folder?.path ?? undefined}
        >
          {displayName}
        </span>
        <span
          className="shrink-0 rounded-full border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
          data-testid="thread-folder-count"
        >
          {threadCount}
        </span>
        {folder && onNewThreadHere ? (
          <Button
            aria-label={`New thread in ${displayName}`}
            data-testid="thread-folder-new-thread"
            onClick={(event) => {
              event.stopPropagation();
              onNewThreadHere(folder);
            }}
            size="icon-xs"
            title={`New thread in ${displayName}`}
            type="button"
            variant="ghost"
          >
            <Plus className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
