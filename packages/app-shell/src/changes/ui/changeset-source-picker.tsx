/**
 * `ChangesetSourcePicker` (BST-1114, W4 Task A): lets the user pick WHICH
 * changeset the Changes surface is looking at.
 *
 * Three source families, per the design:
 * - "Last Turn" — the most recent `agent-run` for the active thread.
 * - "Run range" — thread-scoped, from-run/to-run. NOT implemented in this
 *   pass: there is no existing hook that sources a thread's run history
 *   without new IPC (`use-changeset.ts`/`use-git-inventory.ts` only resolve a
 *   changeset's VIEW and the git topology, neither lists a thread's runs).
 *   Inventing a fake run list would violate NO SILENT FALLBACKS, so the
 *   control is rendered ABSENT rather than fabricated. Tracked as a follow-up
 *   (needs a run-history source — see BST-1114 follow-ups).
 * - Git scopes — one `git-scope` Changeset per repository x worktree x
 *   `GitScope` kind, sourced entirely from `useGitInventory()`'s
 *   `GitInventory` (never from a `basename()` of anything: worktree display
 *   names must come from `WorktreeDescriptor.name`, per the type's own doc
 *   comment in `@brainstrike/types`).
 *
 * Uses `@brainstrike/ui`'s `DropdownMenu` (+ `DropdownMenuSub` for the
 * repository -> worktree -> scope hierarchy) rather than a hand-rolled menu,
 * mirroring `git-workbench-header.tsx`'s repository/worktree/branch pickers.
 */
import type { Changeset, GitInventory, GitScope, WorktreeDescriptor } from '@brainstrike/types';
import {
  Badge,
  Button,
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
import { AlertTriangle, Check, GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';

export interface ChangesetSourcePickerProps {
  readonly changeset: Changeset | null;
  readonly inventory: GitInventory | null;
  /** Most recent `agent-run` id for {@link threadId}, or null if unknown/none. */
  readonly latestRunId: string | null;
  readonly onSelectChangeset: (next: Changeset) => void;
  /** Active thread id, or null when no thread is in scope on this surface. */
  readonly threadId: string | null;
}

/** The `GitScope` kinds this picker offers (excludes `commit`, a history-view concept). */
const OFFERED_GIT_SCOPE_KINDS = ['uncommitted', 'staged', 'unstaged', 'branch-vs-base'] as const;
type OfferedGitScopeKind = (typeof OFFERED_GIT_SCOPE_KINDS)[number];

/** Human label for a `GitScope`. Exported so `changeset-header.tsx` can reuse it in the provenance line without duplicating the switch. */
export function describeGitScopeKind(scope: GitScope): string {
  switch (scope.kind) {
    case 'uncommitted':
      return 'uncommitted';
    case 'staged':
      return 'staged';
    case 'unstaged':
      return 'unstaged';
    case 'branch-vs-base':
      return scope.baseRef ? `vs ${scope.baseRef}` : 'vs base branch';
    case 'commit':
      return `commit ${scope.commitId.slice(0, 7)}`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unhandled GitScope kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function scopeForKind(kind: OfferedGitScopeKind): GitScope {
  return { kind };
}

/** Stable structural key for a `Changeset`, used only to highlight the active selection. */
function changesetKey(changeset: Changeset | null): string | null {
  return changeset === null ? null : JSON.stringify(changeset);
}

function findWorktreeDescriptor(
  inventory: GitInventory | null,
  repositoryRoot: string,
  worktreePath: string
): WorktreeDescriptor | null {
  if (!inventory) {
    return null;
  }
  for (const repository of inventory.repositories) {
    if (repository.identity.repositoryRoot !== repositoryRoot) {
      continue;
    }
    for (const worktree of repository.worktrees) {
      if (worktree.path === worktreePath) {
        return worktree;
      }
    }
  }
  return null;
}

/** Short trigger caption describing the active changeset, or a placeholder. */
function describeActiveSource(changeset: Changeset | null, inventory: GitInventory | null): string {
  if (!changeset) {
    return 'Choose a changeset';
  }
  if (changeset.kind === 'agent-run') {
    return 'Last Turn';
  }
  if (changeset.kind === 'run-range') {
    return 'Run range';
  }
  const worktree = findWorktreeDescriptor(
    inventory,
    changeset.repositoryRoot,
    changeset.worktreePath
  );
  const worktreeName = worktree?.name ?? changeset.worktreePath;
  return `${describeGitScopeKind(changeset.scope)} — ${worktreeName}`;
}

export function ChangesetSourcePicker({
  changeset,
  inventory,
  latestRunId,
  onSelectChangeset,
  threadId,
}: ChangesetSourcePickerProps): ReactElement {
  const activeKey = changesetKey(changeset);
  const canSelectLastTurn = threadId !== null && latestRunId !== null;

  const selectLastTurn = (): void => {
    if (!(threadId && latestRunId)) {
      return;
    }
    onSelectChangeset({ kind: 'agent-run', runId: latestRunId, threadId });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Choose changeset source"
          className="h-8 min-w-0 justify-start gap-2 px-2.5 text-xs"
          data-testid="changeset-source-picker-trigger"
          type="button"
          variant="outline"
        >
          <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">
            {describeActiveSource(changeset, inventory)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80"
        data-testid="changeset-source-picker-menu"
      >
        <DropdownMenuLabel>Agent turns</DropdownMenuLabel>
        <span title={canSelectLastTurn ? undefined : 'No active thread on this surface yet'}>
          <DropdownMenuItem
            data-testid="changeset-source-last-turn"
            disabled={!canSelectLastTurn}
            onSelect={selectLastTurn}
          >
            {activeKey ===
              changesetKey({
                kind: 'agent-run',
                runId: latestRunId ?? '',
                threadId: threadId ?? '',
              }) && canSelectLastTurn ? (
              <Check aria-hidden="true" />
            ) : (
              <span className="size-4" />
            )}
            <span className="min-w-0 flex-1 truncate">Last Turn</span>
          </DropdownMenuItem>
        </span>
        {/*
         * "Run range" is intentionally ABSENT (see module doc comment): no
         * existing hook sources a thread's run history without new IPC, and
         * fabricating one here would violate NO SILENT FALLBACKS.
         */}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Git scopes</DropdownMenuLabel>
        {inventory === null ? (
          <div
            className="px-2 py-1.5 text-muted-foreground text-xs"
            data-testid="changeset-source-inventory-loading"
          >
            Loading repositories…
          </div>
        ) : null}
        {inventory && inventory.errors.length > 0 ? (
          <div
            className="flex flex-col gap-1 px-2 py-1.5"
            data-testid="changeset-source-inventory-errors"
          >
            {inventory.errors.map((message) => (
              <span
                className="flex items-start gap-1.5 text-[11px] text-destructive"
                data-testid="changeset-source-inventory-error"
                key={message}
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                {message}
              </span>
            ))}
          </div>
        ) : null}
        {inventory && inventory.repositories.length === 0 ? (
          <div
            className="px-2 py-1.5 text-muted-foreground text-xs"
            data-testid="changeset-source-no-repositories"
          >
            No Git repositories in your workspace roots.
          </div>
        ) : null}
        {inventory?.repositories.map((repository) => (
          <div className="py-1" key={repository.identity.repositoryRoot}>
            <div className="truncate px-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              {repository.identity.repositoryRoot}
            </div>
            {repository.worktrees.map((worktree) => (
              <DropdownMenuSub key={worktree.path}>
                <DropdownMenuSubTrigger data-testid="changeset-source-worktree">
                  <span className="flex min-w-0 flex-1 flex-col items-start">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium text-sm">{worktree.name}</span>
                      {worktree.trust === 'unvalidated' ? (
                        <Badge
                          className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
                          data-testid="worktree-trust-badge"
                          variant="outline"
                        >
                          <AlertTriangle aria-hidden="true" className="size-3" />
                          Unvalidated
                        </Badge>
                      ) : null}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {worktree.path}
                    </span>
                    {worktree.trust === 'unvalidated' && worktree.trustReason ? (
                      <span
                        className="text-[10px] text-amber-700 dark:text-amber-300"
                        data-testid="worktree-trust-reason"
                      >
                        {worktree.trustReason}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {OFFERED_GIT_SCOPE_KINDS.map((kind) => {
                    const candidate: Changeset = {
                      kind: 'git-scope',
                      repositoryRoot: repository.identity.repositoryRoot,
                      scope: scopeForKind(kind),
                      worktreePath: worktree.path,
                    };
                    const isActive = activeKey === changesetKey(candidate);
                    return (
                      <DropdownMenuItem key={kind} onSelect={() => onSelectChangeset(candidate)}>
                        {isActive ? <Check aria-hidden="true" /> : <span className="size-4" />}
                        <span className="min-w-0 flex-1 truncate capitalize">
                          {describeGitScopeKind(candidate.scope)}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
