import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@brainstrike/ui';
import {
  ClipboardCopy,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderX,
  History,
  type LucideIcon,
  RotateCcw,
  Star,
  TerminalSquare,
  X,
} from 'lucide-react';
import { type ReactElement, useId } from 'react';
import { removedFolderLabel } from './removed-folder';
import type { WorkspaceBarProps, WorkspaceBarRecentRoot, WorkspaceBarRoot } from './workspace-bar';

/** The folder half of the bar's props: everything the Folders menu reads. */
export type FolderMenuProps = Omit<
  WorkspaceBarProps,
  'branchMenu' | 'checkout' | 'checkoutState' | 'mode' | 'onDropItems' | 'threadCheckout' | 'trust'
>;

interface RootAction {
  readonly disabledReason: string | null;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId: string;
}

type RootHandlers = Pick<
  FolderMenuProps,
  | 'leaveWorktreeDisabledReason'
  | 'onAddRecent'
  | 'onCopyPath'
  | 'onMakePrimary'
  | 'onOpenTerminal'
  | 'onRemovePrimary'
  | 'onRemoveSecondary'
  | 'reveal'
> & {
  /**
   * The where-menu offers its Local row, which hands the thread off to its
   * Local folder. Make primary on that folder would do the same, so it is not
   * offered twice.
   */
  readonly handOffOffered: boolean;
};

const REMOVED_PRIMARY_NEEDS_ANOTHER_FOLDER = 'Choose another folder for this thread first.';

/**
 * A folder the workspace no longer serves (BST-1990): the host refuses the
 * thread's runs until it is re-added or leaves the thread. A removed primary
 * can leave only while another thread folder is live, which takes its place.
 */
function removedRootActions(
  root: WorkspaceBarRoot,
  isPrimary: boolean,
  hasOtherLiveFolder: boolean,
  handlers: RootHandlers
): readonly RootAction[] {
  const { path } = root;
  const { onAddRecent, onCopyPath } = handlers;
  return [
    ...(path && onAddRecent
      ? [
          {
            disabledReason: null,
            icon: RotateCcw,
            label: root.reopenFailure ? 'Try again' : 'Reopen folder',
            onSelect: () => onAddRecent(path),
            testId: `workspace-bar-readd-${root.rootId}`,
          },
        ]
      : []),
    // In a worktree, removing the worktree folder (the primary) or the Local
    // folder takes the thread out of it, which waits for its run to end.
    isPrimary
      ? {
          disabledReason: hasOtherLiveFolder
            ? (handlers.leaveWorktreeDisabledReason ?? null)
            : REMOVED_PRIMARY_NEEDS_ANOTHER_FOLDER,
          icon: X,
          label: 'Remove from this thread',
          onSelect: () => handlers.onRemovePrimary(root.rootId),
          testId: `workspace-bar-remove-primary-${root.rootId}`,
        }
      : {
          disabledReason: root.local ? (handlers.leaveWorktreeDisabledReason ?? null) : null,
          icon: X,
          label: 'Remove from this thread',
          onSelect: () => handlers.onRemoveSecondary(root.rootId),
          testId: `workspace-bar-remove-secondary-${root.rootId}`,
        },
    ...(path && onCopyPath
      ? [
          {
            disabledReason: null,
            icon: ClipboardCopy,
            label: 'Copy path',
            onSelect: () => onCopyPath(path),
            testId: `workspace-bar-copy-path-${root.rootId}`,
          },
        ]
      : []),
  ];
}

/**
 * The actions a root row offers, in menu order. A root with none (the primary
 * root on a platform with no reveal/copy bridge) renders as an informational
 * row instead of a submenu the user could open onto an empty list.
 */
function rootActions(
  root: WorkspaceBarRoot,
  isPrimary: boolean,
  hasOtherLiveFolder: boolean,
  handlers: RootHandlers
): readonly RootAction[] {
  if (root.removed) {
    return removedRootActions(root, isPrimary, hasOtherLiveFolder, handlers);
  }
  const actions: RootAction[] = [];
  if (!(isPrimary || (root.local && handlers.handOffOffered))) {
    actions.push({
      disabledReason: handlers.leaveWorktreeDisabledReason ?? null,
      icon: Star,
      label: 'Make primary',
      onSelect: () => handlers.onMakePrimary(root.rootId),
      testId: `workspace-bar-make-primary-${root.rootId}`,
    });
  }
  const { path } = root;
  if (path) {
    const { onCopyPath, onOpenTerminal, reveal } = handlers;
    if (reveal) {
      actions.push({
        disabledReason: null,
        icon: FolderOpen,
        // The platform names its own file manager; this package never does.
        label: reveal.label,
        onSelect: () => reveal.onReveal(path),
        testId: `workspace-bar-reveal-${root.rootId}`,
      });
    }
    if (onOpenTerminal) {
      actions.push({
        disabledReason: null,
        icon: TerminalSquare,
        label: 'Open in Terminal',
        onSelect: () => onOpenTerminal(root.rootId, path),
        testId: `workspace-bar-open-terminal-${root.rootId}`,
      });
    }
    if (onCopyPath) {
      actions.push({
        disabledReason: null,
        icon: ClipboardCopy,
        label: 'Copy path',
        onSelect: () => onCopyPath(path),
        testId: `workspace-bar-copy-path-${root.rootId}`,
      });
    }
  }
  if (!isPrimary) {
    actions.push({
      disabledReason: root.removeDisabledReason ?? null,
      icon: X,
      label: 'Remove from thread',
      onSelect: () => handlers.onRemoveSecondary(root.rootId),
      testId: `workspace-bar-remove-secondary-${root.rootId}`,
    });
  }
  return actions;
}

function RootRowIcon({
  isPrimary,
  root,
}: {
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
}): ReactElement {
  if (root.removed) {
    return <FolderX aria-hidden="true" className="text-destructive size-3.5 shrink-0" />;
  }
  return isPrimary ? (
    <Star aria-hidden="true" className="text-foreground size-3.5 shrink-0 fill-current" />
  ) : (
    <Folder aria-hidden="true" className="size-3.5 shrink-0" />
  );
}

const RootRowContent = ({
  isPrimary,
  root,
}: {
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
}): ReactElement => (
  <>
    <RootRowIcon isPrimary={isPrimary} root={root} />
    {/* flex-1 (not ml-auto) claims the free space: a sub-trigger adds its own
        ml-auto chevron, and two ml-auto siblings split the gap unevenly. */}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{root.displayName}</span>
      {root.removed ? (
        <span className="text-destructive text-xs">{removedFolderLabel(root)}</span>
      ) : null}
    </span>
    {isPrimary || root.local ? (
      <span className="text-muted-foreground shrink-0 text-[10px] tracking-wide uppercase">
        {isPrimary ? 'Primary' : 'Local'}
      </span>
    ) : null}
  </>
);

/**
 * One dropdown item, optionally disabled with a reason rendered as a second
 * line beneath the label (matching a disabled root action's presentation).
 * Shared by root-row actions, "Add folder…", and each Recent row (BST-1400
 * item 12) so all three disabled affordances look and behave identically.
 */
const DisableableMenuItem = ({
  disabledReason,
  icon: Icon,
  label,
  onSelect,
  testId,
  title,
}: {
  readonly disabledReason: string | null;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId: string;
  readonly title?: string | undefined;
}): ReactElement => {
  const disabledReasonId = useId();
  return (
    <DropdownMenuItem
      {...(disabledReason
        ? {
            'aria-describedby': disabledReasonId,
            'aria-disabled': true,
            className: 'cursor-not-allowed',
          }
        : {})}
      data-testid={testId}
      onSelect={(event) => {
        if (disabledReason) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
      {...(title ? { title } : {})}
    >
      <Icon
        aria-hidden="true"
        className={disabledReason ? 'text-muted-foreground size-3.5' : 'size-3.5'}
      />
      <span className="flex min-w-0 flex-col">
        <span className={disabledReason ? 'text-muted-foreground truncate' : 'truncate'}>
          {label}
        </span>
        {disabledReason ? (
          <span className="text-foreground text-xs" id={disabledReasonId}>
            {disabledReason}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
};

/** One of this thread's folders: a submenu of its actions, or an informational row with none. */
export const RootRow = ({
  hasOtherLiveFolder,
  isPrimary,
  root,
  ...handlers
}: {
  readonly hasOtherLiveFolder: boolean;
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
} & RootHandlers): ReactElement => {
  const actions = rootActions(root, isPrimary, hasOtherLiveFolder, handlers);
  const testId = `workspace-bar-root-${root.rootId}`;
  const titleProps = root.path ? { title: root.path } : {};

  if (actions.length === 0) {
    return (
      <DropdownMenuLabel
        className="flex items-center gap-2 font-normal"
        data-testid={testId}
        {...titleProps}
      >
        <RootRowContent isPrimary={isPrimary} root={root} />
      </DropdownMenuLabel>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testId} {...titleProps}>
        <RootRowContent isPrimary={isPrimary} root={root} />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {actions.map(({ disabledReason, icon, label, onSelect, testId: actionTestId }) => (
          <DisableableMenuItem
            disabledReason={disabledReason}
            icon={icon}
            key={actionTestId}
            label={label}
            onSelect={onSelect}
            testId={actionTestId}
          />
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/**
 * "Use another folder…" (BST-1990): offered when none of the thread's folders
 * is live, listing the workspace's other mounted folders.
 */
const UseAnotherFolder = ({
  disabledReason,
  folders,
  onUseFolder,
}: {
  /** In a worktree, using another folder takes the thread out of it, which waits for its run. */
  readonly disabledReason: string | null;
  readonly folders: readonly WorkspaceBarRecentRoot[];
  readonly onUseFolder: (folder: WorkspaceBarRecentRoot) => void;
}): ReactElement => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger data-testid="workspace-bar-use-another-folder">
      <FolderInput aria-hidden="true" className="size-3.5" />
      <span className="flex-1 truncate">Use another folder…</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent>
      {folders.map((folder) => (
        <DisableableMenuItem
          disabledReason={disabledReason}
          icon={Folder}
          key={folder.path}
          label={folder.displayName}
          onSelect={() => onUseFolder(folder)}
          testId={`workspace-bar-use-folder-${folder.path}`}
          title={folder.path}
        />
      ))}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

const SECTION_LABEL_CLASS = 'text-muted-foreground text-[10px] tracking-wide uppercase';

/** "Not in this thread" (BST-1990): a mounted folder joins the thread with one click. */
const NotInThisThread = ({
  addFolderDisabledReason,
  folders,
  onAddWorkspaceFolder,
}: {
  readonly addFolderDisabledReason: string | null;
  readonly folders: readonly WorkspaceBarRecentRoot[];
  readonly onAddWorkspaceFolder: (folder: WorkspaceBarRecentRoot) => void;
}): ReactElement => (
  <>
    <DropdownMenuLabel className={SECTION_LABEL_CLASS}>Not in this thread</DropdownMenuLabel>
    {folders.map((folder) => (
      <DisableableMenuItem
        disabledReason={addFolderDisabledReason}
        icon={FolderPlus}
        key={folder.path}
        label={folder.displayName}
        onSelect={() => onAddWorkspaceFolder(folder)}
        testId={`workspace-bar-add-to-thread-${folder.path}`}
        title={`Add ${folder.path} to this thread`}
      />
    ))}
    <DropdownMenuSeparator />
  </>
);

/** Recent folders the platform can re-mount without a picker. */
const RecentFolders = ({
  addFolderDisabledReason,
  onAddRecent,
  recents,
}: {
  readonly addFolderDisabledReason: string | null;
  readonly onAddRecent: (path: string) => void;
  readonly recents: readonly WorkspaceBarRecentRoot[];
}): ReactElement => (
  <>
    <DropdownMenuLabel className={SECTION_LABEL_CLASS}>Recent</DropdownMenuLabel>
    {recents.map((recent) => (
      <DisableableMenuItem
        disabledReason={addFolderDisabledReason}
        icon={History}
        key={recent.path}
        label={recent.displayName}
        onSelect={() => onAddRecent(recent.path)}
        testId={`workspace-bar-recent-${recent.path}`}
        title={recent.path}
      />
    ))}
    <DropdownMenuSeparator />
  </>
);

/**
 * The where-menu's folder rows: this thread's primary root (★) and its
 * secondaries, the workspace's other mounted folders (one click adds one to the
 * thread), recent folders the platform can re-mount, and "Add folder…". A
 * folder the workspace no longer serves is marked, with its repairs (BST-1990).
 *
 * Rendered as the Folders submenu while the thread has a live primary folder,
 * and in the where-menu itself while it has none. `shownElsewhere` names rows
 * the where-menu already shows at its top level (closed folders' repairs).
 */
export const FolderMenuItems = ({
  addFolderDisabledReason,
  handOffOffered,
  leaveWorktreeDisabledReason,
  onAddFolder,
  onAddRecent,
  onAddWorkspaceFolder,
  onCopyPath,
  onMakePrimary,
  onOpenTerminal,
  onRemovePrimary,
  onRemoveSecondary,
  onUseFolder,
  primaryRoot,
  recentRoots,
  reveal,
  secondaryRoots,
  shownElsewhere,
  workspaceFolders,
}: FolderMenuProps & {
  readonly handOffOffered: boolean;
  readonly shownElsewhere: ReadonlySet<string>;
}): ReactElement => {
  // Recents are an "add another" list: anything already mounted in this thread
  // would be a no-op row.
  const mountedPaths = new Set(
    [primaryRoot, ...secondaryRoots]
      .map((root) => root?.path)
      .filter((path): path is string => Boolean(path))
  );
  const visibleRecents = recentRoots.filter((recent) => !mountedPaths.has(recent.path));
  const rootHandlers = {
    handOffOffered,
    leaveWorktreeDisabledReason,
    onAddRecent,
    onCopyPath,
    onMakePrimary,
    onOpenTerminal,
    onRemovePrimary,
    onRemoveSecondary,
    reveal,
  };
  const liveSecondary = secondaryRoots.some((root) => !root.removed);
  const noLiveFolder = Boolean(primaryRoot?.removed) && !liveSecondary;
  const listedSecondaries = secondaryRoots.filter((root) => !shownElsewhere.has(root.rootId));
  const disabledReason = addFolderDisabledReason ?? null;

  return (
    <>
      {primaryRoot || listedSecondaries.length > 0 ? (
        <>
          <DropdownMenuLabel className={SECTION_LABEL_CLASS}>This thread</DropdownMenuLabel>
          {primaryRoot ? (
            <RootRow
              hasOtherLiveFolder={liveSecondary}
              isPrimary
              root={primaryRoot}
              {...rootHandlers}
            />
          ) : null}
          {listedSecondaries.map((root) => (
            <RootRow
              hasOtherLiveFolder={liveSecondary}
              isPrimary={false}
              key={root.rootId}
              root={root}
              {...rootHandlers}
            />
          ))}
          {noLiveFolder && workspaceFolders.length > 0 ? (
            <UseAnotherFolder
              disabledReason={leaveWorktreeDisabledReason ?? null}
              folders={workspaceFolders}
              onUseFolder={onUseFolder}
            />
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      {noLiveFolder || workspaceFolders.length === 0 ? null : (
        <NotInThisThread
          addFolderDisabledReason={disabledReason}
          folders={workspaceFolders}
          onAddWorkspaceFolder={onAddWorkspaceFolder}
        />
      )}
      {onAddRecent && visibleRecents.length > 0 ? (
        <RecentFolders
          addFolderDisabledReason={disabledReason}
          onAddRecent={onAddRecent}
          recents={visibleRecents}
        />
      ) : null}
      <DisableableMenuItem
        disabledReason={disabledReason}
        icon={FolderPlus}
        label="Add folder…"
        onSelect={onAddFolder}
        testId="workspace-bar-add-folder"
      />
    </>
  );
};
