import { cn, ModelPickerSearch, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Command } from 'cmdk';
import {
  Check,
  ChevronDown,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  RefreshCw,
  SplitSquareHorizontal,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { GROUP_HEADING_CLASS, ROW_CLASS } from '../composer-model-picker';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarBranchRow,
  WorkspaceBarCheckout,
} from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

const BranchGlyphs = ({
  ahead,
  behind,
  checkout,
  label,
}: {
  readonly ahead: string | null;
  readonly behind: string | null;
  readonly checkout: WorkspaceBarCheckout;
  readonly label: string;
}): ReactElement => (
  <>
    <GitBranch aria-hidden="true" />
    <span className="bs-composer-chip-label">{label}</span>
    {ahead ? <span className="bs-composer-chip-badge">{ahead}</span> : null}
    {behind ? <span className="bs-composer-chip-badge">{behind}</span> : null}
    {checkout.dirty ? <span aria-hidden="true" className="bs-composer-dirty-dot" /> : null}
  </>
);

const BRANCH_ROW_CLASS = cn(
  ROW_CLASS,
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
          className={cn(ROW_CLASS, 'pl-8 text-xs')}
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

interface BranchChipGlyphProps {
  readonly ahead: string | null;
  readonly behind: string | null;
  readonly checkout: WorkspaceBarCheckout;
  readonly label: string;
}

/** W1's read-only labelled image — no menu, no branchMenu. */
const ReadOnlyBranchChip = ({
  ahead,
  behind,
  checkout,
  label,
  summary,
}: BranchChipGlyphProps & { readonly summary: string }): ReactElement => (
  <span
    aria-label={summary}
    className="bs-composer-chip bs-composer-chip-long"
    data-dirty={checkout.dirty ? 'true' : 'false'}
    data-testid="workspace-bar-branch-chip"
    role="img"
    title={summary}
  >
    <BranchGlyphs ahead={ahead} behind={behind} checkout={checkout} label={label} />
  </span>
);

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
    <Command className="flex flex-col" label="Branches" loop shouldFilter={false}>
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
              <Command.Group className={GROUP_HEADING_CLASS} heading="Local branches">
                {free.map((row) => (
                  <BranchMenuRow key={row.name} menu={branchMenu} onDone={onDone} row={row} />
                ))}
              </Command.Group>
            ) : null}
            {elsewhere.length > 0 ? (
              <Command.Group className={GROUP_HEADING_CLASS} heading="In other worktrees">
                {elsewhere.map((row) => (
                  <BranchMenuRow key={row.name} menu={branchMenu} onDone={onDone} row={row} />
                ))}
              </Command.Group>
            ) : null}
          </>
        )}
        {canCreate || branchMenu.onFetch ? (
          <Command.Group className={cn(GROUP_HEADING_CLASS, 'border-border/60 border-t')}>
            {canCreate ? (
              <Command.Item
                className={cn(ROW_CLASS, 'text-xs')}
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
                className={cn(ROW_CLASS, 'text-xs')}
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

/** The interactive chip: the branch switcher. */
const BranchMenuChip = ({
  ahead,
  behind,
  branchMenu,
  checkout,
  label,
  summary,
}: BranchChipGlyphProps & {
  readonly branchMenu: WorkspaceBarBranchMenu;
  readonly summary: string;
}): ReactElement => {
  const [open, setOpen] = useState(false);

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && branchMenu.query) {
          branchMenu.onQueryChange('');
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Branch: ${summary}`}
          className="bs-composer-chip bs-composer-chip-long"
          data-dirty={checkout.dirty ? 'true' : 'false'}
          data-testid="workspace-bar-branch-chip"
          title={summary}
          type="button"
        >
          <BranchGlyphs ahead={ahead} behind={behind} checkout={checkout} label={label} />
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Switch branch"
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl p-0"
        data-testid="workspace-bar-branch-menu"
        // Selecting another thread closes the menu and hides this thread's
        // panel in the same click, so the chip is gone while the menu plays
        // its exit animation. Without its anchor the menu would paint at the
        // window's corner for those frames; it hides instead.
        hideWhenDetached={!open}
      >
        <BranchSwitcher branchMenu={branchMenu} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
};

/**
 * Git state for the primary root. Without an interactive menu this preserves
 * W1's read-only labelled image; desktop callers can opt into the switcher by
 * supplying an already-gated branch menu model.
 */
export const BranchChip = ({
  branchMenu,
  checkout,
}: {
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
  readonly checkout: WorkspaceBarCheckout;
}): ReactElement => {
  const label = checkout.branch ?? 'detached';
  const ahead = countBadge(checkout.ahead, '↑');
  const behind = countBadge(checkout.behind, '↓');
  const summary = [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    ahead ? `${checkout.ahead} ahead` : null,
    behind ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter((part) => part !== null)
    .join(' · ');

  if (branchMenu) {
    return (
      <BranchMenuChip
        ahead={ahead}
        behind={behind}
        branchMenu={branchMenu}
        checkout={checkout}
        label={label}
        summary={summary}
      />
    );
  }

  return (
    <ReadOnlyBranchChip
      ahead={ahead}
      behind={behind}
      checkout={checkout}
      label={label}
      summary={summary}
    />
  );
};

BranchChip.displayName = 'BranchChip';
