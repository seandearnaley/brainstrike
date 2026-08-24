import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Check, GitBranch, LoaderCircle } from 'lucide-react';
import { type FormEvent, type ReactElement, useState } from 'react';
import type { WorkspaceBarBranchMenu, WorkspaceBarCheckout } from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

const DIRTY_WORKTREE_REASON =
  'Direct switching is unavailable while this checkout has uncommitted changes. Switching in a new worktree is unavailable until Worktree support lands.';

export const BranchChip = ({
  checkout,
  menu,
}: {
  readonly checkout: WorkspaceBarCheckout;
  readonly menu?: WorkspaceBarBranchMenu | undefined;
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
  const [newBranchName, setNewBranchName] = useState('');
  const [creating, setCreating] = useState(false);

  const chip = (
    <button
      aria-label={menu ? `${summary}. Choose branch` : summary}
      className="inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring enabled:hover:bg-muted enabled:hover:text-foreground"
      data-dirty={checkout.dirty ? 'true' : 'false'}
      data-testid="workspace-bar-branch-chip"
      disabled={!menu}
      title={summary}
      type="button"
    >
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {ahead ? <span className="shrink-0 tabular-nums">{ahead}</span> : null}
      {behind ? <span className="shrink-0 tabular-nums">{behind}</span> : null}
      {checkout.dirty ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">●</span>
      ) : null}
    </button>
  );

  if (!menu) {
    return chip;
  }

  const createBranch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const branch = newBranchName.trim();
    if (!branch) {
      return;
    }
    setCreating(true);
    const created = await menu.onCreateBranch(branch);
    setCreating(false);
    if (created) {
      setNewBranchName('');
    }
  };

  const fetchRemotes = menu.defaultRemote ? [menu.defaultRemote] : menu.remotes;

  return (
    <Popover onOpenChange={menu.onOpenChange}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 space-y-2 p-2"
        data-testid="workspace-bar-branch-popover"
      >
        <Input
          aria-label="Search local branches"
          className="h-8 text-xs"
          data-testid="workspace-bar-branch-search"
          defaultValue={menu.query}
          onChange={(event) => menu.onQueryChange(event.currentTarget.value)}
          placeholder="Search local branches…"
        />

        {checkout.dirty ? (
          <p
            className="rounded-md bg-amber-500/10 px-2 py-1.5 text-amber-800 text-xs dark:text-amber-200"
            data-testid="workspace-bar-dirty-switch-reason"
          >
            {DIRTY_WORKTREE_REASON}
          </p>
        ) : null}

        <div className="max-h-56 space-y-1 overflow-y-auto" role="listbox">
          {menu.loading ? (
            <div className="flex items-center gap-2 px-2 py-3 text-muted-foreground text-xs">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /> Loading
              branches…
            </div>
          ) : null}
          {!menu.loading && menu.rows.length === 0 ? (
            <div className="px-2 py-3 text-muted-foreground text-xs">
              No matching local branches.
            </div>
          ) : null}
          {menu.rows.map((row) => (
            <div key={row.name}>
              <Button
                aria-selected={row.current}
                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                data-testid={`workspace-bar-branch-row-${row.name}`}
                disabled={!row.switchable}
                onClick={() => void menu.onSwitchBranch(row.name)}
                role="option"
                title={row.disabledReason ?? undefined}
                type="button"
                variant="ghost"
              >
                {row.current ? (
                  <Check aria-hidden="true" className="size-3.5 shrink-0" />
                ) : (
                  <span aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.current ? <span className="text-[10px]">Current</span> : null}
                {row.worktreeName ? (
                  <span className="text-[10px]">in worktree: {row.worktreeName}</span>
                ) : null}
              </Button>
              {row.disabledReason ? (
                <p className="px-8 pb-1 text-[10px] text-muted-foreground">{row.disabledReason}</p>
              ) : null}
            </div>
          ))}
        </div>

        <form className="flex gap-1.5 border-border border-t pt-2" onSubmit={createBranch}>
          <Input
            aria-label="New branch name"
            className="h-8 min-w-0 text-xs"
            data-testid="workspace-bar-branch-new-name"
            onChange={(event) => setNewBranchName(event.currentTarget.value)}
            placeholder="New branch…"
            value={newBranchName}
          />
          <Button
            className="h-8"
            data-testid="workspace-bar-create-branch"
            disabled={creating || newBranchName.trim().length === 0}
            size="sm"
            type="submit"
          >
            Create
          </Button>
        </form>

        <div className="flex flex-wrap gap-1.5 border-border border-t pt-2">
          {fetchRemotes.map((remote) => (
            <Button
              data-testid={`workspace-bar-fetch-${remote}`}
              key={remote}
              onClick={() => void menu.onFetch(remote)}
              size="sm"
              type="button"
              variant="outline"
            >
              Fetch {remote}
            </Button>
          ))}
          {fetchRemotes.length === 0 ? (
            <Button
              disabled
              size="sm"
              title="No Git remote is configured"
              type="button"
              variant="outline"
            >
              Fetch
            </Button>
          ) : null}
          <Button
            className="ml-auto"
            data-testid="workspace-bar-open-changes"
            onClick={menu.onOpenChanges}
            size="sm"
            type="button"
            variant="outline"
          >
            Open in Changes
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

BranchChip.displayName = 'BranchChip';
