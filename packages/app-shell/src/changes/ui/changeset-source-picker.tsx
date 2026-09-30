/**
 * `ChangesetSourcePicker` (BST-1114, W4 Task A): lets the user pick WHICH
 * changeset the Changes surface is looking at.
 *
 * Three source families, per the design:
 * - "Last Turn" — the most recent `agent-run` for the active thread. A
 *   STANDING scope (BST-1115 smoke feedback): it enables the moment a thread
 *   is active (`threadId` present), independent of any "→ Review" handoff.
 *   `latestRunId === null` (a thread with no completed turns observed yet)
 *   still disables it, with an honest reason distinct from "no thread at
 *   all" — see `describeActiveSource`'s caller,
 *   `AssistantUiPanelWrapper.setActiveThreadIdentity`, for how the identity
 *   is populated and kept live.
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
import { describeGitScopeKind } from './git-scope-label';

export interface ChangesetSourcePickerProps {
  readonly changeset: Changeset | null;
  readonly inventory: GitInventory | null;
  /** Most recent `agent-run` id for {@link threadId}, or null if unknown/none. */
  readonly latestRunId: string | null;
  readonly onSelectChangeset: (next: Changeset) => void;
  /**
   * Fires the "Last Turn" selection specifically (BST-1115 smoke feedback) —
   * distinct from `onSelectChangeset` so the caller can track "the user is on
   * Last Turn" for live retargeting without inferring it from run-id
   * equality. Takes no arguments: the caller resolves the CURRENT identity at
   * call time, never a value closed over from this render.
   */
  readonly onSelectLastTurn: () => void;
  /** Active thread id, or null when no thread is in scope on this surface. */
  readonly threadId: string | null;
}

/** The `GitScope` kinds this picker offers (excludes `commit`, a history-view concept). */
const OFFERED_GIT_SCOPE_KINDS = ['uncommitted', 'staged', 'unstaged', 'branch-vs-base'] as const;
type OfferedGitScopeKind = (typeof OFFERED_GIT_SCOPE_KINDS)[number];

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
  onSelectLastTurn,
  threadId,
}: ChangesetSourcePickerProps): ReactElement {
  const activeKey = changesetKey(changeset);
  const canSelectLastTurn = threadId !== null && latestRunId !== null;
  // Two distinct honest-absence reasons (BST-1115 smoke feedback): no active
  // thread at all, vs. a thread with nothing completed in it yet.
  const lastTurnDisabledReason =
    threadId === null ? 'No active thread on this surface yet' : 'No completed turns yet';

  const handleSelectLastTurn = (): void => {
    if (!canSelectLastTurn) {
      return;
    }
    onSelectLastTurn();
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
        <span title={canSelectLastTurn ? undefined : lastTurnDisabledReason}>
          <DropdownMenuItem
            data-testid="changeset-source-last-turn"
            disabled={!canSelectLastTurn}
            onSelect={handleSelectLastTurn}
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
            {repository.worktrees.map((worktree) => {
              // A worktree with `containment: 'outside-roots'` has no
              // containing workspace root — `resolveContainedWorktreeCwd`
              // deterministically fails with `outside-roots-unsupported` for
              // it, so its scopes can never resolve. Disable the trigger
              // itself (never a submenu of items that all fail) rather than
              // offering a dead menu.
              const isResolvable = worktree.containment !== 'outside-roots';
              const unresolvableReason =
                "This worktree isn't inside any workspace root and can't be opened here.";
              return (
                <DropdownMenuSub key={worktree.path}>
                  <span title={isResolvable ? undefined : unresolvableReason}>
                    <DropdownMenuSubTrigger
                      data-testid="changeset-source-worktree"
                      disabled={!isResolvable}
                    >
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-sm">{worktree.name}</span>
                          {worktree.trust === 'unvalidated' ? (
                            <Badge
                              className="gap-1 border-amber-500/40 text-warning"
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
                            className="text-[10px] text-warning"
                            data-testid="worktree-trust-reason"
                          >
                            {worktree.trustReason}
                          </span>
                        ) : null}
                        {isResolvable ? null : (
                          <span
                            className="text-[10px] text-muted-foreground"
                            data-testid="worktree-unresolvable-reason"
                          >
                            Outside every workspace root
                          </span>
                        )}
                      </span>
                    </DropdownMenuSubTrigger>
                  </span>
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
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
