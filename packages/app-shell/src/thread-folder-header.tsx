/**
 * Section header for the Threads panel's `groupBy: 'folder'` view (BST-1405,
 * ADR-0034, owner decisions 2026-11-10): a repository, a folder outside one, "Scratch" or
 * "No project". Each of the first two is a project, the interface word for it; a folder outside
 * git is a project with one checkout. Scratch holds every thread that works in a scratch folder
 * the host made for it, and offers no new thread: one starts from New thread with no folder open.
 *
 * Deliberately NOT `ThreadGroupHeader` with a different icon. A custom group is
 * a durable object the user creates, renames, colors, reorders and drops
 * threads into; a folder section is a VIEW over where each thread already
 * works (its binding). So this header carries no appearance, no delete and no
 * drop target, only the section's identity, the branch a repository's own
 * checkout is on, its live count, and the actions that belong to a project:
 * start a thread in it, and (ADR-0034 build decisions) name the project, move
 * its folder into another project, and locate a folder that moved. A named
 * project's section reads its name. Re-binding an EXISTING thread stays where
 * the binding is made, the composer's Folders menu, and the header says so in
 * its tooltip.
 */
import {
  type ThreadFolderRow,
  type ThreadListFolderSection,
  threadFolderSectionLabel,
} from '@brainstrike/assistant-data';
import { Button } from '@brainstrike/ui';
import { Folder, FolderPen, FolderX, GitBranch, Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { THREAD_CONTROL_ACTION_CLASS_NAME } from './assistant-thread-presentation';
import { ThreadMarkChip } from './thread-identity-mark';
import { useThreadProjectActions } from './thread-project-actions';
import {
  ThreadProjectMenu,
  ThreadProjectRenameForm,
  type ThreadSectionProject,
} from './thread-project-menu';
import { ThreadSectionHeader } from './thread-section-header';

/**
 * Why the header offers no way to move a thread between folders. Rendered as
 * the section's tooltip so the missing drag target reads as a rule rather than
 * a gap.
 */
const THREAD_FOLDER_GROUPING_HINT =
  "Grouped by the project each thread works in — change it from the composer's Folders menu.";

/** What the Scratch section holds, since its name is not a folder's. */
const THREAD_SCRATCH_SECTION_HINT =
  'Threads sent with no folder open, each working in a scratch folder Brainstrike made for it.';

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
      const { branch, detached, folder, path } = header.repository;
      return {
        // A detached HEAD has no branch name; a bare repository has neither and shows nothing.
        branch: detached ? 'detached' : branch,
        displayName: threadFolderSectionLabel(header),
        newThreadFolder: folder,
        path,
      };
    }
    case 'folder':
      return {
        branch: null,
        displayName: threadFolderSectionLabel(header),
        newThreadFolder: header.folder,
        path: header.folder.path,
      };
    case 'scratch':
      return { branch: null, displayName: 'Scratch', newThreadFolder: null, path: null };
    case 'unassigned':
      return { branch: null, displayName: 'No project', newThreadFolder: null, path: null };
    default: {
      const exhaustive: never = header;
      throw new Error(`Unknown thread folder header: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

/**
 * The project a section stands for, with the folder its actions act on: the repository's own
 * checkout, or the folder. A repository found inside an open folder has a project but no folder
 * of its own (BST-2511): it is named by its checkout's path, and never located. Null for a
 * section with no project, and for Scratch and No project.
 */
function sectionProject(header: ThreadListFolderSection['header']): ThreadSectionProject | null {
  if (header.kind === 'unassigned' || header.kind === 'scratch') {
    return null;
  }
  const label = threadFolderSectionLabel(header);
  if (header.kind === 'folder') {
    const { folder } = header;
    return folder.projectId === null
      ? null
      : {
          folder: { rootId: folder.rootId },
          folderName: folder.displayName,
          label,
          locateRootId: folder.status === 'disconnected' ? folder.rootId : null,
          name: folder.projectName,
          projectId: folder.projectId,
        };
  }
  const { repository } = header;
  if (repository.projectId === null) {
    return null;
  }
  return {
    folder:
      repository.folder === null
        ? { repositoryPath: repository.path }
        : { rootId: repository.folder.rootId },
    folderName: repository.folder?.displayName ?? repository.displayName,
    label,
    locateRootId: null,
    name: repository.projectName,
    projectId: repository.projectId,
  };
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
  const projectActions = useThreadProjectActions();
  const project = projectActions ? sectionProject(header) : null;
  const [renaming, setRenaming] = useState(false);
  if (renaming && projectActions && project) {
    return (
      <ThreadSectionHeader
        count={threadCount}
        countTestId="thread-folder-count"
        label={
          <ThreadProjectRenameForm
            onDone={() => {
              setRenaming(false);
              projectActions.dismiss();
            }}
            onRename={(name) => projectActions.rename(project.projectId, name)}
            project={project}
          />
        }
        mark={
          <ThreadMarkChip color={null} testId="thread-folder-icon">
            <Folder className="size-3" />
          </ThreadMarkChip>
        }
        testId="thread-folder-header"
      />
    );
  }
  return (
    <ThreadSectionHeader
      actions={
        <>
          {newThreadFolder && onNewThreadHere ? (
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
          ) : null}
          {projectActions && project ? (
            <ThreadProjectMenu
              actions={projectActions}
              onRenameStart={() => setRenaming(true)}
              project={project}
            />
          ) : null}
        </>
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
      mark={<ThreadFolderMark kind={header.kind} />}
      testId="thread-folder-header"
      title={header.kind === 'scratch' ? THREAD_SCRATCH_SECTION_HINT : THREAD_FOLDER_GROUPING_HINT}
    />
  );
}

function ThreadFolderMark({
  kind,
}: {
  readonly kind: ThreadListFolderSection['header']['kind'];
}): ReactElement {
  if (kind === 'scratch') {
    return (
      <ThreadMarkChip color={null} testId="thread-folder-scratch-icon">
        <FolderPen className="size-3" />
      </ThreadMarkChip>
    );
  }
  if (kind === 'unassigned') {
    return (
      <ThreadMarkChip color={null} testId="thread-folder-unassigned-icon">
        <FolderX className="size-3" />
      </ThreadMarkChip>
    );
  }
  return (
    <ThreadMarkChip color={null} testId="thread-folder-icon">
      <Folder className="size-3" />
    </ThreadMarkChip>
  );
}
