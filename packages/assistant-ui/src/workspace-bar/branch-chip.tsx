import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@brainstrike/ui';
import {
  Check,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  RefreshCw,
  SplitSquareHorizontal,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarBranchRow,
  WorkspaceBarCheckout,
} from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

const CHIP_CLASSES =
  'inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground';

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
    <GitBranch aria-hidden="true" className="size-3 shrink-0" />
    <span className="truncate">{label}</span>
    {ahead ? <span className="shrink-0 tabular-nums">{ahead}</span> : null}
    {behind ? <span className="shrink-0 tabular-nums">{behind}</span> : null}
    {checkout.dirty ? <span className="shrink-0 text-amber-600 dark:text-amber-400">●</span> : null}
  </>
);

const BranchMenuRow = ({
  menu,
  row,
}: {
  readonly menu: WorkspaceBarBranchMenu;
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
      <DropdownMenuItem
        className="items-start font-mono text-[11px]"
        data-testid={`workspace-bar-branch-row-${row.name}`}
        disabled={!row.switchable || menu.pending}
        onSelect={() => menu.onSwitch(row.name)}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {row.current ? <Check aria-hidden="true" className="size-3.5" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{row.name}</span>
          {row.disabledReason ? (
            <span
              className="block whitespace-normal text-[10px] text-muted-foreground"
              data-testid={`workspace-bar-branch-reason-${row.name}`}
            >
              {row.disabledReason}
            </span>
          ) : null}
          {row.worktreeName ? (
            <span className="block truncate text-[10px] text-muted-foreground">
              Worktree: {row.worktreeName}
            </span>
          ) : null}
        </span>
      </DropdownMenuItem>
      {showsWorktreeAction ? (
        <DropdownMenuItem
          className="pl-8 text-[11px]"
          data-testid={`workspace-bar-branch-worktree-${row.name}`}
          disabled={menu.pending}
          onSelect={() => onSwitchInNewWorktree(row.name)}
        >
          <SplitSquareHorizontal aria-hidden="true" className="size-3.5" />
          Switch in a new worktree
        </DropdownMenuItem>
      ) : null}
    </>
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
  const [newBranchName, setNewBranchName] = useState('');
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

  if (!branchMenu) {
    return (
      <span
        aria-label={summary}
        className={CHIP_CLASSES}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        role="img"
        title={summary}
      >
        <BranchGlyphs ahead={ahead} behind={behind} checkout={checkout} label={label} />
      </span>
    );
  }

  const trimmedNewBranchName = newBranchName.trim();
  const createBranch = (): void => {
    if (branchMenu.pending || trimmedNewBranchName.length === 0) {
      return;
    }
    branchMenu.onCreateBranch(trimmedNewBranchName);
    setNewBranchName('');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Branch: ${summary}`}
        className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        title={summary}
      >
        <BranchGlyphs ahead={ahead} behind={behind} checkout={checkout} label={label} />
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="p-1">
          <Input
            aria-label="Filter branches"
            className="h-8 font-mono text-xs"
            data-testid="workspace-bar-branch-search"
            onChange={(event) => branchMenu.onQueryChange(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Filter branches"
            value={branchMenu.query}
          />
        </div>
        <DropdownMenuLabel className="px-3 py-1 text-[10px] text-muted-foreground uppercase tracking-wide">
          Local branches
        </DropdownMenuLabel>
        {branchMenu.pending ? (
          <span className="block px-3 py-1 text-[10px] text-muted-foreground">
            Branch operation in progress.
          </span>
        ) : null}
        {branchMenu.scopeReason ? (
          <span
            className="block px-3 py-2 text-muted-foreground text-xs"
            data-testid="workspace-bar-branch-scope-reason"
          >
            {branchMenu.scopeReason}
          </span>
        ) : (
          branchMenu.rows.map((row) => <BranchMenuRow key={row.name} menu={branchMenu} row={row} />)
        )}
        <DropdownMenuSeparator />
        <div className="flex gap-1 p-1">
          <Input
            aria-label="New branch name"
            className="h-8 font-mono text-xs"
            data-testid="workspace-bar-branch-new-name"
            disabled={branchMenu.pending}
            onChange={(event) => setNewBranchName(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="New branch name"
            value={newBranchName}
          />
          <Button
            data-testid="workspace-bar-branch-create"
            disabled={branchMenu.pending || trimmedNewBranchName.length === 0}
            onClick={createBranch}
            size="icon-sm"
            title="Create branch"
            type="button"
            variant="outline"
          >
            <GitBranchPlus aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Create branch</span>
          </Button>
        </div>
        {branchMenu.onFetch ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="workspace-bar-branch-fetch"
              disabled={branchMenu.pending}
              onSelect={branchMenu.onFetch}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Fetch
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

BranchChip.displayName = 'BranchChip';
