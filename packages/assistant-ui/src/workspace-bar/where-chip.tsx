import {
  checkoutName,
  LOCAL_CHECKOUT_NAME,
} from '@brainstrike/assistant-contract/thread-checkout-name';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  Archive,
  ChevronDown,
  Folder,
  FolderGit2,
  FolderX,
  GitBranchPlus,
  Home,
  type LucideIcon,
  TriangleAlert,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { BranchSubmenu } from './branch-menu';
import { FolderMenuItems, type FolderMenuProps, RootRow } from './folders-menu';
import { removedFolderLabel, removedFolderState } from './removed-folder';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarMode,
  WorkspaceBarRoot,
  WorkspaceBarThreadCheckout,
  WorkspaceBarWorktreeSummary,
} from './workspace-bar';
import { WorktreeArchiveConfirmationDialog } from './worktree-archive-confirmation-dialog';
import { WorktreeCreateDialog } from './worktree-create-dialog';
import { WorktreePickerDialog } from './worktree-picker-dialog';

export type WhereChipProps = FolderMenuProps & {
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
  readonly checkout?: WorkspaceBarCheckout | undefined;
  readonly mode?: WorkspaceBarMode | undefined;
  /** See `WorkspaceBarProps.openRequest`. */
  readonly openRequest?: number | undefined;
  readonly threadCheckout?: WorkspaceBarThreadCheckout | undefined;
};

const SECTION_LABEL_CLASS = 'text-muted-foreground text-[10px] tracking-wide uppercase';
/** The where-menu's exit keeps its scale (tw-animate-css reads `--tw-exit-scale`). */
const WHERE_MENU_EXIT = { '--tw-exit-scale': '1' } as CSSProperties;
const NO_IDS: ReadonlySet<string> = new Set();

type WhereFacts = Pick<WhereChipProps, 'mode' | 'secondaryRoots' | 'threadCheckout'> & {
  readonly primaryRoot: WorkspaceBarRoot;
};

/**
 * The worktree the thread works in, by name: from its binding when app-shell
 * gives it, else from `mode` or from its Local folder, which only a thread in
 * a worktree has. Null while it works in its folder itself.
 */
function worktreeNameOf({ mode, primaryRoot, secondaryRoots, threadCheckout }: WhereFacts) {
  if (threadCheckout) {
    return threadCheckout.worktreePath === null ? null : checkoutName(threadCheckout.worktreePath);
  }
  if (mode?.worktree) {
    return checkoutName(mode.worktree.path);
  }
  return secondaryRoots.some((root) => root.local) ? primaryRoot.displayName : null;
}

/**
 * Whether the closed control says Local for a thread in its folder itself: the
 * checkout is known (the binding, or `mode`), the folder is open, and nothing
 * about it warns. A folder outside git is Local too (ADR-0034 decision 1).
 */
function localNamed({ mode, primaryRoot, threadCheckout }: WhereFacts): boolean {
  const known = threadCheckout !== undefined || mode !== undefined;
  const warns = Boolean(mode?.disabledReason) && mode?.notARepository !== true;
  return known && !primaryRoot.removed && !warns;
}

/**
 * What the closed control says: `<project> · <checkout>`, the Threads panel's
 * words for the checkout (owner decision 2026-11-11). In a worktree the project
 * is the thread's Local folder, the one a hand-off returns to.
 */
interface WhereSummary {
  readonly accessibleName: string;
  /** "Local" or the worktree's folder name; null when no checkout is known. */
  readonly checkout: string | null;
  /** The thread's folders beyond its project and its worktree. */
  readonly extra: number;
  readonly icon: LucideIcon;
  readonly iconClassName: string | undefined;
  /** "(closed)" after the folder the workspace no longer serves. */
  readonly project: string | null;
  readonly title: string | undefined;
  readonly warning: boolean;
}

/** Why the checkout part shows a warning: a failed setup, or a diagnostic other than "not a repository". */
function checkoutWarning(mode: WorkspaceBarMode | undefined): string | null {
  if (mode?.disabledReason && !mode.notARepository) {
    return mode.disabledReason;
  }
  return mode?.worktree?.setupStatus === 'failed' ? 'setup failed' : null;
}

function withState(name: string, root: WorkspaceBarRoot | undefined): string {
  return root?.removed ? `${name} (${removedFolderLabel(root, true)})` : name;
}

function summaryIcon(
  primaryRoot: WorkspaceBarRoot,
  worktreeName: string | null,
  checkout: string | null
): Pick<WhereSummary, 'icon' | 'iconClassName'> {
  if (primaryRoot.removed) {
    return { icon: FolderX, iconClassName: 'text-destructive' };
  }
  if (worktreeName) {
    return { icon: FolderGit2, iconClassName: undefined };
  }
  return { icon: checkout === LOCAL_CHECKOUT_NAME ? Home : Folder, iconClassName: undefined };
}

function describeWhere(
  props: Pick<
    WhereChipProps,
    'checkout' | 'mode' | 'primaryRoot' | 'secondaryRoots' | 'threadCheckout'
  >
): WhereSummary {
  const { checkout, mode, primaryRoot, secondaryRoots, threadCheckout } = props;
  if (!primaryRoot) {
    return {
      accessibleName: 'Choose a folder',
      checkout: null,
      extra: 0,
      icon: Folder,
      iconClassName: undefined,
      project: 'Choose a folder',
      title: undefined,
      warning: false,
    };
  }
  const facts = { mode, primaryRoot, secondaryRoots, threadCheckout };
  const localRoot = secondaryRoots.find((root) => root.local);
  const worktreeName = worktreeNameOf(facts);
  const projectRoot = worktreeName === null ? primaryRoot : localRoot;
  const checkoutLabel = worktreeName ?? (localNamed(facts) ? checkoutName(null) : null);
  const extra = secondaryRoots.filter((root) => !root.local).length;
  const warning = checkoutWarning(mode);
  const spokenProject = projectRoot ? withState(projectRoot.displayName, projectRoot) : null;
  const spokenCheckout =
    worktreeName === null ? checkoutLabel : withState(worktreeName, primaryRoot);
  const spoken = [
    [spokenProject, extra > 0 ? `${extra} more` : null].filter(Boolean).join(', '),
    spokenCheckout,
  ]
    .filter(Boolean)
    .join(' · ');
  const details = [checkout?.dirty ? 'uncommitted changes' : null, warning].filter(Boolean);
  // The chip shows the state alone; its accessible name and the menu carry the host's reason.
  const visibleState = (root: WorkspaceBarRoot | undefined): string =>
    root?.removed ? ` (${removedFolderState(root).toLowerCase()})` : '';
  return {
    accessibleName: [`Where this thread works: ${spoken}`, ...details].join(', '),
    checkout:
      checkoutLabel === null
        ? null
        : `${checkoutLabel}${worktreeName ? visibleState(primaryRoot) : ''}`,
    extra,
    ...summaryIcon(primaryRoot, worktreeName, checkoutLabel),
    project: projectRoot ? `${projectRoot.displayName}${visibleState(projectRoot)}` : null,
    title: mode?.disabledReason ?? primaryRoot.path,
    warning: warning !== null,
  };
}

/** A row's label, with why the row is disabled underneath it when it is. */
const RowLabel = ({
  aside,
  label,
  reason,
  reasonTestId,
}: {
  readonly aside?: string | null | undefined;
  readonly label: string;
  readonly reason: string | null;
  readonly reasonTestId?: string | undefined;
}): ReactElement => (
  <span className="min-w-0 flex-1">
    <span className="flex items-baseline gap-2">
      <span className="truncate">{label}</span>
      {aside ? (
        <span className="text-muted-foreground ml-auto truncate font-mono text-xs">{aside}</span>
      ) : null}
    </span>
    {reason ? (
      <span
        className="text-muted-foreground text-2xs block whitespace-normal"
        data-testid={reasonTestId}
      >
        {reason}
      </span>
    ) : null}
  </span>
);

/** A thin second line under a checkout row. */
const RowNote = ({
  children,
  testId,
  tone = 'muted',
}: {
  readonly children: ReactNode;
  readonly testId: string;
  readonly tone?: 'muted' | 'warning';
}): ReactElement => (
  <span
    className={`text-2xs block pr-2 pb-1 pl-8 leading-snug ${tone === 'warning' ? 'text-warning' : 'text-muted-foreground'}`}
    data-testid={testId}
  >
    {children}
  </span>
);

function setupNote(worktree: WorkspaceBarWorktreeSummary): string | null {
  if (!worktree.setupReason) {
    return null;
  }
  if (worktree.setupStatus === 'failed' || worktree.setupStatus === 'skipped') {
    return `Setup ${worktree.setupStatus}: ${worktree.setupReason}`;
  }
  return worktree.setupReason;
}

/** The project the checkouts belong to, and where its Local folder is. */
const ProjectRow = ({ root }: { readonly root: WorkspaceBarRoot }): ReactElement => (
  <DropdownMenuLabel
    className="flex items-baseline gap-2 font-medium"
    data-testid="workspace-bar-where-project"
    {...(root.path ? { title: root.path } : {})}
  >
    <span className="truncate">{root.displayName}</span>
    {root.path ? (
      <span className="text-muted-foreground ml-auto truncate font-mono text-xs font-normal">
        {root.path}
      </span>
    ) : null}
  </DropdownMenuLabel>
);

/**
 * "Local": the thread's own folder. Checked while the thread works there; in a
 * worktree, choosing it is Hand off to Local.
 */
const LocalRow = ({
  branch,
  mode,
}: {
  readonly branch: string | null;
  readonly mode: WorkspaceBarMode;
}): ReactElement => {
  if (!mode.worktree) {
    return (
      <>
        <DropdownMenuCheckboxItem checked data-testid="workspace-bar-where-local">
          <RowLabel aside={branch} label={LOCAL_CHECKOUT_NAME} reason={null} />
        </DropdownMenuCheckboxItem>
        {/* ADR-0034 Automatic isolation (PR #5357). */}
        <RowNote testId="workspace-bar-where-local-isolation">
          Moves to a worktree of its own if another thread is editing here.
        </RowNote>
      </>
    );
  }
  if (!mode.onHandOffToLocal) {
    return (
      <DropdownMenuLabel className="pl-8 font-normal" data-testid="workspace-bar-where-local">
        <RowLabel aside={branch} label={LOCAL_CHECKOUT_NAME} reason={null} />
      </DropdownMenuLabel>
    );
  }
  return (
    <DropdownMenuCheckboxItem
      checked={false}
      className={mode.checkoutChangeDisabledReason ? 'items-start' : undefined}
      data-testid="workspace-bar-mode-handoff"
      disabled={mode.pending || mode.checkoutChangeDisabledReason !== null}
      onSelect={mode.onHandOffToLocal}
    >
      <RowLabel
        aside={branch}
        label={LOCAL_CHECKOUT_NAME}
        reason={mode.checkoutChangeDisabledReason}
        reasonTestId="workspace-bar-mode-handoff-disabled-reason"
      />
    </DropdownMenuCheckboxItem>
  );
};

/** The worktree the thread works in, checked, with its setup outcome when it has one. */
const WorktreeRow = ({
  worktree,
}: {
  readonly worktree: WorkspaceBarWorktreeSummary;
}): ReactElement => {
  const note = setupNote(worktree);
  return (
    <>
      <DropdownMenuCheckboxItem
        checked
        data-testid="workspace-bar-where-worktree"
        title={worktree.path}
      >
        <RowLabel
          aside={worktree.detached ? 'Detached HEAD' : (worktree.branch ?? 'Detached HEAD')}
          label={checkoutName(worktree.path)}
          reason={null}
        />
      </DropdownMenuCheckboxItem>
      {note ? (
        <RowNote testId="workspace-bar-mode-setup-reason" tone="warning">
          {note}
        </RowNote>
      ) : null}
    </>
  );
};

/** The Local folder's branch in a worktree, read from the worktree list (its primary checkout). */
function localBranch(
  mode: WorkspaceBarMode,
  checkout: WorkspaceBarCheckout | undefined,
  localRoot: WorkspaceBarRoot | undefined
): string | null {
  if (!mode.worktree) {
    return checkout ? (checkout.branch ?? 'detached') : null;
  }
  const path = localRoot?.path;
  return path ? (mode.picker.options.find((option) => option.path === path)?.branch ?? null) : null;
}

/** Local, the current worktree, and the two ways to another one. */
const CheckoutRows = ({
  checkout,
  localRoot,
  mode,
  onOpenCreate,
  projectRoot,
}: {
  readonly checkout: WorkspaceBarCheckout | undefined;
  readonly localRoot: WorkspaceBarRoot | undefined;
  readonly mode: WorkspaceBarMode;
  readonly onOpenCreate: () => void;
  readonly projectRoot: WorkspaceBarRoot | undefined;
}): ReactElement => {
  if (mode.disabledReason) {
    // M3 ruling: a mode that is unavailable says why, visibly and keyboard-reachable.
    return (
      <>
        {projectRoot ? <ProjectRow root={projectRoot} /> : null}
        <div
          className="text-muted-foreground text-2xs px-2 pb-2"
          data-testid="workspace-bar-mode-diagnostic"
        >
          {mode.disabledReason}
        </div>
      </>
    );
  }
  const changeReason = mode.checkoutChangeDisabledReason;
  return (
    <>
      {projectRoot ? <ProjectRow root={projectRoot} /> : null}
      <LocalRow branch={localBranch(mode, checkout, localRoot)} mode={mode} />
      {mode.worktree ? <WorktreeRow worktree={mode.worktree} /> : null}
      <DropdownMenuItem
        className={changeReason ? 'items-start pl-8' : 'pl-8'}
        data-testid="workspace-bar-mode-pick-worktree"
        disabled={mode.pending || changeReason !== null}
        onSelect={mode.onOpenPicker}
      >
        <RowLabel
          label="Other worktree…"
          reason={changeReason}
          reasonTestId="workspace-bar-mode-pick-worktree-disabled-reason"
        />
      </DropdownMenuItem>
      <DropdownMenuItem
        className="items-start pl-8"
        data-testid="workspace-bar-mode-new-worktree"
        disabled={mode.pending || mode.createDisabledReason !== null}
        onSelect={onOpenCreate}
      >
        <RowLabel
          label="New worktree…"
          reason={mode.createDisabledReason}
          reasonTestId="workspace-bar-mode-create-disabled-reason"
        />
      </DropdownMenuItem>
    </>
  );
};

/** Actions on the worktree the thread works in — each present only when its handler exists. */
const WorktreeActions = ({
  mode,
  worktree,
}: {
  readonly mode: WorkspaceBarMode;
  readonly worktree: WorkspaceBarWorktreeSummary;
}): ReactElement | null => {
  if (!(mode.onCreateBranchHere || mode.onArchive)) {
    return null;
  }
  return (
    <>
      <DropdownMenuSeparator />
      {mode.onCreateBranchHere ? (
        <DropdownMenuItem
          data-testid="workspace-bar-mode-create-branch-here"
          disabled={mode.pending}
          onSelect={() => {
            void mode
              .onCreateBranchHere?.(`${mode.defaultBranchPrefix}${worktree.name}`)
              // The app-shell handler owns the visible failure toast.
              .catch(() => undefined);
          }}
        >
          <GitBranchPlus aria-hidden="true" className="size-3.5" />
          Create branch here
        </DropdownMenuItem>
      ) : null}
      {mode.onArchive ? (
        <DropdownMenuItem
          className={mode.checkoutChangeDisabledReason ? 'items-start' : undefined}
          data-testid="workspace-bar-mode-archive"
          disabled={mode.pending || mode.checkoutChangeDisabledReason !== null}
          onSelect={mode.onArchive}
        >
          <Archive aria-hidden="true" className="size-3.5" />
          <RowLabel
            label="Archive worktree…"
            reason={mode.checkoutChangeDisabledReason}
            reasonTestId="workspace-bar-mode-archive-disabled-reason"
          />
        </DropdownMenuItem>
      ) : null}
    </>
  );
};

/** "Folders: brainstrike +1": the thread's folders and the ways to add one, a level down. */
const FoldersSubmenu = ({
  folders,
  handOffOffered,
  project,
  shownElsewhere,
}: {
  readonly folders: FolderMenuProps;
  readonly handOffOffered: boolean;
  readonly project: string;
  readonly shownElsewhere: ReadonlySet<string>;
}): ReactElement => {
  const others = folders.secondaryRoots.length;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="workspace-bar-folders">
        <Folder aria-hidden="true" className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          Folders: {project}
          {others > 0 ? <span className="bs-composer-chip-badge">{` +${others}`}</span> : null}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <FolderMenuItems
          {...folders}
          handOffOffered={handOffOffered}
          shownElsewhere={shownElsewhere}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/** The open where-menu: the checkout, then its branch and folders, then the worktree's own actions. */
const WhereMenuBody = ({
  busy,
  onDone,
  onOpenCreate,
  props,
}: {
  /** A worktree operation is in progress (see `WhereChip`'s `operationMode`). */
  readonly busy: boolean;
  readonly onDone: () => void;
  readonly onOpenCreate: () => void;
  readonly props: WhereChipProps;
}): ReactElement => {
  const { branchMenu, checkout, mode, ...folders } = props;
  const { primaryRoot, secondaryRoots } = folders;
  const localRoot = secondaryRoots.find((root) => root.local);
  const inWorktree = Boolean(mode?.worktree) || localRoot !== undefined;
  const projectRoot = inWorktree ? localRoot : primaryRoot;
  const primaryLive = primaryRoot !== undefined && !primaryRoot.removed;
  // A closed folder's repairs stay at the top level (BST-1990); the Folders submenu omits it.
  const closed = primaryLive ? secondaryRoots.filter((root) => root.removed) : [];
  const handOffOffered = Boolean(mode?.worktree && mode.onHandOffToLocal && !mode.disabledReason);
  const rootHandlers = {
    handOffOffered,
    leaveWorktreeDisabledReason: folders.leaveWorktreeDisabledReason,
    onAddRecent: folders.onAddRecent,
    onCopyPath: folders.onCopyPath,
    onMakePrimary: folders.onMakePrimary,
    onOpenTerminal: folders.onOpenTerminal,
    onRemovePrimary: folders.onRemovePrimary,
    onRemoveSecondary: folders.onRemoveSecondary,
    reveal: folders.reveal,
  };

  return (
    <>
      <DropdownMenuLabel className={SECTION_LABEL_CLASS}>Where this thread works</DropdownMenuLabel>
      {busy ? (
        <span className="text-muted-foreground text-2xs block px-3 py-1">
          Worktree operation in progress.
        </span>
      ) : null}
      {mode ? (
        <CheckoutRows
          checkout={checkout}
          localRoot={localRoot}
          mode={mode}
          onOpenCreate={onOpenCreate}
          projectRoot={projectRoot}
        />
      ) : null}
      {closed.map((root) => (
        <RootRow
          hasOtherLiveFolder
          isPrimary={false}
          key={root.rootId}
          root={root}
          {...rootHandlers}
        />
      ))}
      {mode || closed.length > 0 ? <DropdownMenuSeparator /> : null}
      {primaryLive ? (
        <>
          {checkout ? (
            <BranchSubmenu branchMenu={branchMenu} checkout={checkout} onDone={onDone} />
          ) : null}
          <FoldersSubmenu
            folders={folders}
            handOffOffered={handOffOffered}
            project={projectRoot?.displayName ?? primaryRoot.displayName}
            shownElsewhere={new Set(closed.map((root) => root.rootId))}
          />
        </>
      ) : (
        <FolderMenuItems {...folders} handOffOffered={handOffOffered} shownElsewhere={NO_IDS} />
      )}
      {mode?.worktree && !mode.disabledReason ? (
        <WorktreeActions mode={mode} worktree={mode.worktree} />
      ) : null}
    </>
  );
};

/** The closed control: `<project> +N · <checkout>`, the uncommitted-changes dot, and a warning. */
const WhereChipLabel = ({
  dirty,
  summary,
}: {
  readonly dirty: boolean;
  readonly summary: WhereSummary;
}): ReactElement => {
  const Icon = summary.icon;
  return (
    <>
      <Icon aria-hidden="true" className={summary.iconClassName} />
      {summary.project ? <span className="bs-composer-chip-label">{summary.project}</span> : null}
      {summary.extra > 0 ? (
        <span className="bs-composer-chip-badge">{`+${summary.extra}`}</span>
      ) : null}
      {summary.checkout ? (
        <span className="bs-composer-chip-label">
          {summary.project ? `· ${summary.checkout}` : summary.checkout}
        </span>
      ) : null}
      {dirty ? <span aria-hidden="true" className="bs-composer-dirty-dot" /> : null}
      {summary.warning ? <TriangleAlert aria-hidden="true" className="text-warning" /> : null}
      <ChevronDown aria-hidden="true" />
    </>
  );
};

/**
 * Where this thread works (ADR-0034): one control for its folder, its branch
 * and its checkout. Closed it reads `<project> · <checkout>`; open it lists
 * Local and the thread's worktree, the ways to another worktree, the Branch and
 * Folders submenus, and the worktree's own actions. Every row keeps the handler
 * it had as its own chip. "Cloud" is deliberately absent, not a disabled row.
 *
 * Not modal: like the branch switcher's popover before it, a click on another
 * thread closes the menu and selects that thread in the same click.
 *
 * The create and picker dialogs live INSIDE this component's JSX because
 * dialog nesting depth is LEXICAL (`ui-conventions.md`): hoisting either one
 * would drop it to tier 1 and paint its scrim under the menu's own popup.
 *
 * A worktree operation outlives the mode for a moment: once it moves the
 * thread, app-shell withholds the mode until the new folder's first git status
 * read settles (`useWorkspaceBarMode`, BST-2129). The operation's sheet and
 * dialogs, and the busy state, keep the last mode through that window
 * (`operationMode`). Gated on the live mode, the create sheet unmounted mid-
 * operation and came back as a fresh sheet when the status settled, and that
 * sheet took focus from an open where-menu and closed it.
 */
export const WhereChip = (props: WhereChipProps): ReactElement => {
  const { checkout, mode, openRequest } = props;
  const [open, setOpen] = useState(false);
  // Another surface asks this control to open by raising `openRequest`, adjusted
  // while rendering like `lastMode` below; the value it was first shown with is
  // not a request.
  const [lastOpenRequest, setLastOpenRequest] = useState(openRequest);
  if (openRequest !== lastOpenRequest) {
    setLastOpenRequest(openRequest);
    setOpen(true);
  }
  const [createOpen, setCreateOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreCreateFocusRef = useRef(false);
  const summary = describeWhere(props);
  // The last mode app-shell gave, adjusted while rendering (React's pattern for
  // state derived from a prop), so it is never read from a ref during render.
  const [lastMode, setLastMode] = useState(mode);
  if (mode !== undefined && mode !== lastMode) {
    setLastMode(mode);
  }
  // Held only while an operation is in flight or its sheet is open: a mode that
  // is gone for any other reason takes its dialogs with it.
  const operationMode = mode ?? (lastMode?.pending || createOpen ? lastMode : undefined);
  const busy = operationMode?.pending === true;

  useLayoutEffect(() => {
    if (createOpen || !shouldRestoreCreateFocusRef.current) {
      return;
    }
    shouldRestoreCreateFocusRef.current = false;
    triggerRef.current?.focus();
  }, [createOpen]);

  const onOpenCreate = (): void => {
    void mode
      ?.onOpenCreateSheet()
      .then(() => setCreateOpen(true))
      // The app-shell handler owns the visible failure toast.
      .catch(() => undefined);
  };

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger
          aria-label={summary.accessibleName}
          // The closed control's only sign that a worktree operation is running.
          {...(busy ? { 'aria-busy': true } : {})}
          className="bs-composer-chip bs-composer-chip-where"
          data-dirty={checkout?.dirty ? 'true' : 'false'}
          data-setup={mode?.worktree?.setupStatus ?? 'none'}
          data-testid="workspace-bar-where-chip"
          ref={triggerRef}
          {...(summary.title ? { title: summary.title } : {})}
        >
          <WhereChipLabel dirty={checkout?.dirty === true} summary={summary} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80"
          // Selecting another thread hides this one's panel in the same click,
          // so the control is gone while the menu plays its exit animation.
          // Without its anchor the menu would paint at the window's corner for
          // those frames; it hides instead.
          hideWhenDetached={!open}
          // As a non-modal Radix popover does: the control's own trigger is not
          // outside it. A menu that just closed returns focus to the trigger a
          // task after it unmounts, which must not dismiss a reopened one.
          onInteractOutside={(event) => {
            if (event.target instanceof Node && triggerRef.current?.contains(event.target)) {
              event.preventDefault();
            }
          }}
          // Upward, as the composer's other menus open. Placed by Radix's
          // default (below, flipping when short of room), a menu opened while
          // its git-dependent rows were still arriving was placed below the
          // composer from its short first render, and the rows that came next
          // were squeezed into a scrolling strip: focusing a row scrolled it, and
          // a submenu anchored to that row moved when the strip did.
          side="top"
          // Closes by fading, without the shared shrink: a submenu open inside
          // it is part of its box, so shrinking the menu toward its corner drew
          // the submenu along (16px for the Branch switcher) instead of letting
          // it fade where it is. The submenu's own close still shrinks in place.
          style={WHERE_MENU_EXIT}
        >
          <WhereMenuBody
            busy={busy}
            onDone={() => setOpen(false)}
            onOpenCreate={onOpenCreate}
            props={props}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {operationMode && createOpen ? (
        <WorktreeCreateDialog
          mode={operationMode}
          onOpenChange={(next: boolean) => {
            if (!next) {
              shouldRestoreCreateFocusRef.current = true;
            }
            setCreateOpen(next);
            if (!next) {
              triggerRef.current?.focus();
            }
          }}
          open={createOpen}
        />
      ) : null}
      {operationMode ? (
        <WorktreePickerDialog picker={operationMode.picker} triggerRef={triggerRef} />
      ) : null}
      {operationMode?.archiveConfirmation ? (
        <WorktreeArchiveConfirmationDialog confirmation={operationMode.archiveConfirmation} />
      ) : null}
    </>
  );
};

WhereChip.displayName = 'WhereChip';
