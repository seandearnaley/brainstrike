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
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorkspaceBarProps, WorkspaceBarRoot } from './workspace-bar';

type FolderChipProps = Omit<WorkspaceBarProps, 'checkout'>;

interface RootAction {
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
    'onCopyPath' | 'onMakePrimary' | 'onRemoveSecondary' | 'onRevealRoot'
  >
): readonly RootAction[] {
  const actions: RootAction[] = [];
  if (!isPrimary) {
    actions.push({
      icon: Star,
      label: 'Make primary',
      onSelect: () => handlers.onMakePrimary(root.rootId),
      testId: `workspace-bar-make-primary-${root.rootId}`,
    });
  }
  const { path } = root;
  if (path) {
    const { onCopyPath, onRevealRoot } = handlers;
    if (onRevealRoot) {
      actions.push({
        icon: FolderOpen,
        label: 'Reveal in Finder',
        onSelect: () => onRevealRoot(path),
        testId: `workspace-bar-reveal-${root.rootId}`,
      });
    }
    if (onCopyPath) {
      actions.push({
        icon: ClipboardCopy,
        label: 'Copy path',
        onSelect: () => onCopyPath(path),
        testId: `workspace-bar-copy-path-${root.rootId}`,
      });
    }
  }
  if (!isPrimary) {
    actions.push({
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
    <span className="truncate">{root.displayName}</span>
    {isPrimary ? (
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
        Primary
      </span>
    ) : null}
  </>
);

const RootRow = ({
  isPrimary,
  root,
  ...handlers
}: {
  readonly isPrimary: boolean;
  readonly root: WorkspaceBarRoot;
} & Pick<
  FolderChipProps,
  'onCopyPath' | 'onMakePrimary' | 'onRemoveSecondary' | 'onRevealRoot'
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
        {actions.map(({ icon: Icon, label, onSelect, testId: actionTestId }) => (
          <DropdownMenuItem data-testid={actionTestId} key={actionTestId} onSelect={onSelect}>
            <Icon aria-hidden="true" className="size-3.5" />
            {label}
          </DropdownMenuItem>
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
  onAddFolder,
  onAddRecent,
  onCopyPath,
  onMakePrimary,
  onRemoveSecondary,
  onRevealRoot,
  primaryRoot,
  recentRoots,
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
  const rootHandlers = { onCopyPath, onMakePrimary, onRemoveSecondary, onRevealRoot };

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
        {primaryRoot ? (
          <>
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              This thread
            </DropdownMenuLabel>
            <RootRow isPrimary root={primaryRoot} {...rootHandlers} />
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
              <DropdownMenuItem
                data-testid={`workspace-bar-recent-${recent.path}`}
                key={recent.path}
                onSelect={() => onAddRecent(recent.path)}
                title={recent.path}
              >
                <History aria-hidden="true" className="size-3.5" />
                <span className="truncate">{recent.displayName}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem data-testid="workspace-bar-add-folder" onSelect={onAddFolder}>
          <FolderPlus aria-hidden="true" className="size-3.5" />
          Add folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

FolderChip.displayName = 'FolderChip';
