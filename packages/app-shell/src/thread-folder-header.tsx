/**
 * Section header for the Threads panel's `groupBy: 'folder'` view (BST-1405,
 * ADR-0034, owner decisions 2026-11-10): a repository, a folder outside one, or "No project".
 * Each is a project, the interface word for it; a folder outside git is a
 * project with one checkout.
 *
 * Deliberately NOT `ThreadGroupHeader` with a different icon. A custom group is
 * a durable object the user creates, renames, colors, reorders and drops
 * threads into; a folder section is a VIEW over where each thread already
 * works (its binding). So this header carries no rename, no appearance, no
 * delete and no drop target, only the section's identity, the branch a
 * repository's own checkout is on, its live count, and the one action that
 * belongs to a folder: start a thread in it. Re-binding an EXISTING thread
 * stays where the binding is made, the composer's folder chip, and the header
 * says so in its tooltip.
 */
import type { ThreadFolderRow, ThreadListFolderSection } from '@brainstrike/assistant-data';
import { Button } from '@brainstrike/ui';
import { Folder, FolderX, GitBranch, Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { THREAD_CONTROL_ACTION_CLASS_NAME } from './assistant-thread-presentation';
import { ThreadMarkChip } from './thread-identity-mark';
import { ThreadSectionHeader } from './thread-section-header';

/**
 * Why the header offers no way to move a thread between folders. Rendered as
 * the section's tooltip so the missing drag target reads as a rule rather than
 * a gap.
 */
const THREAD_FOLDER_GROUPING_HINT =
  "Grouped by the project each thread works in — change it from the composer's folder chip.";

/** What a header shows, whichever kind of section it leads. */
interface ThreadFolderHeaderFacts {
  /** The branch the repository's own checkout is on, `detached`, or none to show. */
  readonly branch: string | null;
  readonly displayName: string;
  /** Where "New thread here" starts one; null where there is no open folder to start it in. */
  readonly newThreadFolder: ThreadFolderRow | null;
  /** A name is not an identity and two sections can share one; the path tells them apart. */
  readonly path: string | null;
}

function folderHeaderFacts(header: ThreadListFolderSection['header']): ThreadFolderHeaderFacts {
  switch (header.kind) {
    case 'repository': {
      const { branch, detached, displayName, folder, path } = header.repository;
      return {
        // A detached HEAD has no branch name; a bare repository has neither and shows nothing.
        branch: detached ? 'detached' : branch,
        displayName,
        newThreadFolder: folder,
        path,
      };
    }
    case 'folder':
      return {
        branch: null,
        displayName: header.folder.displayName,
        newThreadFolder: header.folder,
        path: header.folder.path,
      };
    case 'unassigned':
      return { branch: null, displayName: 'No project', newThreadFolder: null, path: null };
    default: {
      const exhaustive: never = header;
      throw new Error(`Unknown thread folder header: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

export function ThreadFolderHeader({
  header,
  onNewThreadHere,
  threadCount,
}: {
  readonly header: ThreadListFolderSection['header'];
  /** `null` while no repository is ready to create a thread. */
  readonly onNewThreadHere: ((folder: ThreadFolderRow) => void) | null;
  readonly threadCount: number;
}): ReactElement {
  const { branch, displayName, newThreadFolder, path } = folderHeaderFacts(header);
  const unassigned = header.kind === 'unassigned';
  return (
    <ThreadSectionHeader
      actions={
        newThreadFolder && onNewThreadHere ? (
          <Button
            aria-label={`New thread in ${displayName}`}
            className={THREAD_CONTROL_ACTION_CLASS_NAME}
            data-testid="thread-folder-new-thread"
            onClick={(event) => {
              event.stopPropagation();
              onNewThreadHere(newThreadFolder);
            }}
            size="icon-xs"
            title={`New thread in ${displayName}`}
            type="button"
            variant="ghost"
          >
            <Plus className="size-3.5" />
          </Button>
        ) : null
      }
      count={threadCount}
      countTestId="thread-folder-count"
      label={
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className="min-w-0 truncate text-xs leading-4 font-medium"
            title={path ?? undefined}
          >
            {displayName}
          </span>
          {branch ? (
            <span
              // Never squeezed out by a long name: the name truncates first and
              // the branch keeps up to its share of the row.
              className="text-muted-foreground text-2xs flex max-w-[45%] shrink-0 items-center gap-0.5 leading-4"
              data-testid="thread-folder-branch"
              title={`On ${branch}`}
            >
              <GitBranch aria-hidden="true" className="size-2.5 shrink-0" />
              <span className="min-w-0 truncate">{branch}</span>
            </span>
          ) : null}
        </span>
      }
      mark={
        <ThreadMarkChip
          color={null}
          testId={unassigned ? 'thread-folder-unassigned-icon' : 'thread-folder-icon'}
        >
          {unassigned ? <FolderX className="size-3" /> : <Folder className="size-3" />}
        </ThreadMarkChip>
      }
      testId="thread-folder-header"
      title={THREAD_FOLDER_GROUPING_HINT}
    />
  );
}
