import {
  cn,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  ModelPickerSearch,
  PICKER_GROUP_HEADING_CLASS,
  PICKER_ROW_CLASS,
} from '@brainstrike/ui';
import { Command } from 'cmdk';
import {
  Check,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  RefreshCw,
  SplitSquareHorizontal,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarBranchRow,
  WorkspaceBarCheckout,
} from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

/** "On branch main · 2 ahead · uncommitted changes": the branch row's spoken summary. */
function branchSummary(checkout: WorkspaceBarCheckout): string {
  return [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    countBadge(checkout.ahead, '↑') ? `${checkout.ahead} ahead` : null,
    countBadge(checkout.behind, '↓') ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

const BRANCH_ROW_CLASS = cn(
  PICKER_ROW_CLASS,
  'data-[disabled=true]:text-muted-foreground items-start font-mono text-xs data-[disabled=true]:opacity-100'
);

const BranchMenuRow = ({
  menu,
  onDone,
  row,
}: {
  readonly menu: WorkspaceBarBranchMenu;
  readonly onDone: () => void;
  readonly row: WorkspaceBarBranchRow;
}): ReactElement => {
  const onSwitchInNewWorktree = menu.onSwitchInNewWorktree;
  const showsWorktreeAction =
    onSwitchInNewWorktree !== undefined &&
    !row.switchable &&
    !row.current &&
    row.worktreeName === null;

  return (
    <>
      <Command.Item
        className={BRANCH_ROW_CLASS}
        data-testid={`workspace-bar-branch-row-${row.name}`}
        disabled={!row.switchable || menu.pending}
        onSelect={() => {
          menu.onSwitch(row.name);
          onDone();
        }}
        value={`branch:${row.name}`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {row.current ? (
            <Check aria-label="Current branch" className="size-3.5" role="img" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', row.current ? 'font-medium' : undefined)}>
            {row.name}
          </span>
          {row.disabledReason ? (
            <span
              className="text-muted-foreground text-2xs block font-sans whitespace-normal"
              data-testid={`workspace-bar-branch-reason-${row.name}`}
            >
              {row.disabledReason}
            </span>
          ) : null}
        </span>
        {row.worktreeName ? (
          <span className="text-muted-foreground text-2xs flex shrink-0 items-center gap-1 font-sans">
            <FolderGit2 aria-hidden="true" className="size-3" />
            <span className="sr-only">Checked out in worktree </span>
            {row.worktreeName}
          </span>
        ) : null}
      </Command.Item>
      {showsWorktreeAction ? (
        // Follow-up: checkout-existing-branch create mode replaces this detached-at-tip stopgap.
        <Command.Item
          className={cn(PICKER_ROW_CLASS, 'pl-8 text-xs')}
          data-testid={`workspace-bar-branch-worktree-${row.name}`}
          disabled={menu.pending}
          onSelect={() => {
            onSwitchInNewWorktree(row.name);
            onDone();
          }}
          value={`worktree:${row.name}`}
        >
          <SplitSquareHorizontal aria-hidden="true" className="size-3.5" />
          Switch in a new worktree (detached at this branch&apos;s tip)
        </Command.Item>
      ) : null}
    </>
  );
};

/**
 * The branch switcher: search first, then local branches, with branches held
 * by another worktree in their own group so a repository with many worktrees
 * stays scannable. Typing a name that matches no branch offers to create it,
 * the GitHub / VS Code idiom, so creation needs no second field. Filtering is
 * the caller's (`onQueryChange`), so cmdk only navigates.
 */
const BranchSwitcher = ({
  branchMenu,
  onDone,
}: {
  readonly branchMenu: WorkspaceBarBranchMenu;
  readonly onDone: () => void;
}): ReactElement => {
  const newBranchName = branchMenu.query.trim();
  const free = branchMenu.rows.filter((row) => row.worktreeName === null);
  const elsewhere = branchMenu.rows.filter((row) => row.worktreeName !== null);
  const canCreate =
    newBranchName.length > 0 && !branchMenu.rows.some((row) => row.name === newBranchName);

  return (
    <Command
      className="flex flex-col"
      label="Branches"
      loop
      // cmdk handles its keys first; none then reach the enclosing menu, whose
      // typeahead, arrow handling and ArrowLeft-to-close would take them from
      // the search field.
      onKeyDown={(event) => event.stopPropagation()}
      shouldFilter={false}
    >
      <ModelPickerSearch
        aria-label="Filter branches"
        data-testid="workspace-bar-branch-search"
        onValueChange={branchMenu.onQueryChange}
        placeholder="Switch or create a branch…"
        value={branchMenu.query}
      />
      {branchMenu.pending ? (
        <span className="text-muted-foreground text-2xs block px-3 pt-2" role="status">
          Branch operation in progress.
        </span>
      ) : null}
      <Command.List className="max-h-[min(50vh,22rem)] overflow-y-auto p-1">
        {branchMenu.scopeReason ? (
          <p
            className="text-muted-foreground px-2 py-2 text-xs"
            data-testid="workspace-bar-branch-scope-reason"
          >
            {branchMenu.scopeReason}
          </p>
        ) : (
          <>
            <Command.Empty className="text-muted-foreground px-2 py-6 text-center text-sm">
              No branches match.
            </Command.Empty>
            {free.length > 0 ? (
              <Command.Group className={PICKER_GROUP_HEADING_CLASS} heading="Local branches">
                {free.map((row) => (
                  <BranchMenuRow key={row.name} menu={branchMenu} onDone={onDone} row={row} />
                ))}
              </Command.Group>
            ) : null}
            {elsewhere.length > 0 ? (
              <Command.Group className={PICKER_GROUP_HEADING_CLASS} heading="In other worktrees">
                {elsewhere.map((row) => (
                  <BranchMenuRow key={row.name} menu={branchMenu} onDone={onDone} row={row} />
                ))}
              </Command.Group>
            ) : null}
          </>
        )}
        {canCreate || branchMenu.onFetch ? (
          <Command.Group className={cn(PICKER_GROUP_HEADING_CLASS, 'border-border/60 border-t')}>
            {canCreate ? (
              <Command.Item
                className={cn(PICKER_ROW_CLASS, 'text-xs')}
                data-testid="workspace-bar-branch-create"
                disabled={branchMenu.pending}
                onSelect={() => {
                  branchMenu.onCreateBranch(newBranchName);
                  branchMenu.onQueryChange('');
                  onDone();
                }}
                value="action:create"
              >
                <GitBranchPlus aria-hidden="true" className="size-3.5" />
                <span className="min-w-0 truncate">
                  Create branch <span className="font-mono font-medium">{newBranchName}</span>
                </span>
              </Command.Item>
            ) : null}
            {branchMenu.onFetch ? (
              <Command.Item
                className={cn(PICKER_ROW_CLASS, 'text-xs')}
                data-testid="workspace-bar-branch-fetch"
                disabled={branchMenu.pending}
                onSelect={branchMenu.onFetch}
                value="action:fetch"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Fetch from remote
              </Command.Item>
            ) : null}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command>
  );
};

/** The branch, its ahead/behind counts and the uncommitted-changes dot, as the row shows them. */
const BranchRowContent = ({
  checkout,
}: {
  readonly checkout: WorkspaceBarCheckout;
}): ReactElement => {
  const ahead = countBadge(checkout.ahead, '↑');
  const behind = countBadge(checkout.behind, '↓');
  return (
    <>
      <GitBranch aria-hidden="true" className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">
        Branch: <span className="font-mono">{checkout.branch ?? 'detached'}</span>
      </span>
      {ahead ? <span className="bs-composer-chip-badge text-xs">{ahead}</span> : null}
      {behind ? <span className="bs-composer-chip-badge text-xs">{behind}</span> : null}
      {checkout.dirty ? <span aria-hidden="true" className="bs-composer-dirty-dot" /> : null}
    </>
  );
};

/**
 * The where-menu's Branch row: the branch switcher as a submenu, or, without
 * an interactive menu (web, no git bridge), a read-only row with the same
 * summary. The switcher is a cmdk list whose search field owns its keys, so
 * none reach the menu's own typeahead, arrow handling or ArrowLeft-to-close.
 */
export const BranchSubmenu = ({
  branchMenu,
  checkout,
  onDone,
}: {
  readonly branchMenu: WorkspaceBarBranchMenu | undefined;
  readonly checkout: WorkspaceBarCheckout;
  /** Closes the where-menu after a branch action, as the switcher's own popover did. */
  readonly onDone: () => void;
}): ReactElement => {
  const summary = branchSummary(checkout);
  if (!branchMenu) {
    return (
      <DropdownMenuLabel
        aria-label={`Branch: ${summary}`}
        className="flex items-center gap-2 font-normal"
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch"
        role="img"
        title={summary}
      >
        <BranchRowContent checkout={checkout} />
      </DropdownMenuLabel>
    );
  }
  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (!open && branchMenu.query) {
          branchMenu.onQueryChange('');
        }
      }}
    >
      <DropdownMenuSubTrigger
        aria-label={`Branch: ${summary}`}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch"
        title={summary}
      >
        <BranchRowContent checkout={checkout} />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-0"
        data-testid="workspace-bar-branch-menu"
        // Opened from the keyboard, the menu focuses the submenu itself; the
        // search field takes that focus, as it did when the switcher was its
        // own popover.
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            event.currentTarget.querySelector('input')?.focus();
          }
        }}
      >
        <BranchSwitcher branchMenu={branchMenu} onDone={onDone} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};
