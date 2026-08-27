import {
  DropdownMenu,
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
  ChevronDown,
  ClipboardCopy,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  type LucideIcon,
  Star,
  TerminalSquare,
  X,
} from 'lucide-react';
import { type ReactElement, useId } from 'react';
import type { WorkspaceBarProps, WorkspaceBarRoot } from './workspace-bar';

type FolderChipProps = Omit<WorkspaceBarProps, 'checkout'>;

interface RootAction {
  readonly disabledReason: string | null;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId: string;
}

/**
 * The actions a root row offers, in menu order. A root with none (the primary
 * root on a platform with no reveal/copy bridge) renders as an informational
 * row instead of a submenu the user could open onto an empty list.
 */
function rootActions(
  root: WorkspaceBarRoot,
  isPrimary: boolean,
  handlers: Pick<
    FolderChipProps,
    'onCopyPath' | 'onMakePrimary' | 'onOpenTerminal' | 'onRemoveSecondary' | 'reveal'
  >
): readonly RootAction[] {
  const actions: RootAction[] = [];
  if (!isPrimary) {
    actions.push({
      disabledReason: null,
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

const RootRowContent = ({
  isPrimary,
  root,
}: {
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
}): ReactElement => (
  <>
    {isPrimary ? (
      <Star aria-hidden="true" className="size-3.5 shrink-0 fill-current text-foreground" />
    ) : (
      <Folder aria-hidden="true" className="size-3.5 shrink-0" />
    )}
    {/* flex-1 (not ml-auto) claims the free space: a sub-trigger adds its own
        ml-auto chevron, and two ml-auto siblings split the gap unevenly. */}
    <span className="flex-1 truncate">{root.displayName}</span>
    {isPrimary ? (
      <span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
        Primary
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
        className={disabledReason ? 'size-3.5 text-muted-foreground' : 'size-3.5'}
      />
      <span className="flex min-w-0 flex-col">
        <span className={disabledReason ? 'truncate text-muted-foreground' : 'truncate'}>
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

const RootRow = ({
  isPrimary,
  root,
  ...handlers
}: {
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
} & Pick<
  FolderChipProps,
  'onCopyPath' | 'onMakePrimary' | 'onOpenTerminal' | 'onRemoveSecondary' | 'reveal'
>): ReactElement => {
  const actions = rootActions(root, isPrimary, handlers);
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
 * The workspace bar's folder control: this thread's primary root (★) and its
 * secondaries, recent folders the platform can re-mount, and "Add folder…".
 * With no root connected the chip IS the call to action.
 */
export const FolderChip = ({
  addFolderDisabledReason,
  onAddFolder,
  onAddRecent,
  onCopyPath,
  onMakePrimary,
  onOpenTerminal,
  onRemoveSecondary,
  primaryRoot,
  recentRoots,
  reveal,
  secondaryRoots,
}: FolderChipProps): ReactElement => {
  const secondaryCount = primaryRoot ? secondaryRoots.length : 0;
  const label = primaryRoot ? primaryRoot.displayName : 'Choose a folder';
  const accessibleName = primaryRoot
    ? `Folder: ${primaryRoot.displayName}${secondaryCount > 0 ? `, ${secondaryCount} more` : ''}`
    : 'Choose a folder';
  // Recents are an "add another" list: anything already mounted in this thread
  // would be a no-op row.
  const mountedPaths = new Set(
    [primaryRoot, ...secondaryRoots]
      .map((root) => root?.path)
      .filter((path): path is string => Boolean(path))
  );
  const visibleRecents = recentRoots.filter((recent) => !mountedPaths.has(recent.path));
  const rootHandlers = { onCopyPath, onMakePrimary, onOpenTerminal, onRemoveSecondary, reveal };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={accessibleName}
        className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
        data-testid="workspace-bar-folder-chip"
        {...(primaryRoot?.path ? { title: primaryRoot.path } : {})}
      >
        <Folder aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
        {secondaryCount > 0 ? (
          <span className="shrink-0 tabular-nums opacity-80">{`+${secondaryCount}`}</span>
        ) : null}
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {primaryRoot || secondaryRoots.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              This thread
            </DropdownMenuLabel>
            {primaryRoot ? <RootRow isPrimary root={primaryRoot} {...rootHandlers} /> : null}
            {secondaryRoots.map((root) => (
              <RootRow isPrimary={false} key={root.rootId} root={root} {...rootHandlers} />
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onAddRecent && visibleRecents.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Recent
            </DropdownMenuLabel>
            {visibleRecents.map((recent) => (
              <DisableableMenuItem
                disabledReason={addFolderDisabledReason ?? null}
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
        ) : null}
        <DisableableMenuItem
          disabledReason={addFolderDisabledReason ?? null}
          icon={FolderPlus}
          label="Add folder…"
          onSelect={onAddFolder}
          testId="workspace-bar-add-folder"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

FolderChip.displayName = 'FolderChip';
