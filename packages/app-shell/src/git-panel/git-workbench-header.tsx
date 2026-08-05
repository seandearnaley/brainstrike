import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { GitInventory } from '@brainstrike/types';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { Check, ChevronDown, FolderGit2, FolderTree, GitBranch, RefreshCw } from 'lucide-react';
import type { ComponentPropsWithRef, ReactElement } from 'react';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { useGitInventory } from '../changes/use-git-inventory';
import type { GitRepository, GitStatus, GitWorktreeSummary } from './git-bridge';

interface GitWorkbenchHeaderProps {
  readonly fetchRemote: (remote: string) => Promise<void>;
  readonly isLoading: boolean;
  readonly isSyncing: boolean;
  readonly refreshStatus: () => void;
  readonly repository: GitRepository;
  readonly status: GitStatus;
  readonly switchBranch: (branch: string) => Promise<void>;
}

interface WorktreeNavigation {
  /** Non-null exactly when `navigable` is false — states WHY, never a silent disable. */
  readonly disabledReason: string | null;
  readonly navigable: boolean;
}

/**
 * Cross-bridge identity match: `GitRepository.repositoryRoot` (the desktop
 * `window.git` bridge) against `RepositoryIdentity.repositoryRoot` (the
 * `window.changes` inventory bridge) — the same stable-key convention
 * `changeset-header.tsx` and `changeset-source-picker.tsx` already rely on to
 * cross-reference the two bridges.
 */
function findWorktreeDescriptor(
  inventory: GitInventory,
  repositoryRoot: string,
  worktreePath: string
): GitInventory['repositories'][number]['worktrees'][number] | null {
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

/**
 * Trust-gates a worktree dropdown entry (BST-1116 Task C). NO SILENT
 * FALLBACKS: an out-of-root, unvalidated, locked, or not-yet-indexed worktree
 * is disabled with a stated reason, never quietly enabled or hidden — and the
 * stated reason must be TRUE, which is why `inventoryAvailable` is its own
 * branch rather than collapsing into the not-yet-loaded one. Mirrors
 * `changeset-source-picker.tsx`'s worktree gating (same `outside-roots`
 * copy) plus the additional lock/trust/inventory-honesty checks this task
 * brief requires.
 */
function resolveWorktreeNavigation(
  worktree: GitWorktreeSummary,
  repositoryRoot: string,
  inventory: GitInventory | null,
  inventoryError: string | null,
  inventoryAvailable: boolean
): WorktreeNavigation {
  // Checked FIRST: without a `window.changes` bridge `useGitInventory`
  // reports `inventory: null` with `error: null` forever, which the
  // not-yet-loaded branch below would render as a permanent "Loading…" —
  // a stated reason that is simply false. (`git` and `changes` are
  // independently gated in `preload.ts`'s `shouldExposeBridge`, so one can
  // be present without the other.)
  if (!inventoryAvailable) {
    return {
      disabledReason: 'Repository inventory is unavailable in this build.',
      navigable: false,
    };
  }
  if (inventoryError) {
    return {
      disabledReason: `Repository inventory unavailable: ${inventoryError}`,
      navigable: false,
    };
  }
  if (!inventory) {
    return { disabledReason: 'Loading repository inventory…', navigable: false };
  }
  const descriptor = findWorktreeDescriptor(inventory, repositoryRoot, worktree.path);
  if (!descriptor) {
    return { disabledReason: 'Not found in the workspace inventory yet.', navigable: false };
  }
  // `trust: 'unvalidated'` only ever occurs for an `outside-roots` worktree
  // (see `WorktreeDescriptor.trust`'s doc comment), so this branch is
  // strictly narrower than the containment check below — checked first for
  // its more specific, bidirectional-check-derived reason.
  if (descriptor.trust === 'unvalidated') {
    return {
      disabledReason:
        descriptor.trustReason ?? 'This worktree could not be verified against its own .git.',
      navigable: false,
    };
  }
  if (descriptor.containment === 'outside-roots') {
    return {
      disabledReason: "This worktree isn't inside any workspace root and can't be opened here.",
      navigable: false,
    };
  }
  if (worktree.lockedReason !== null) {
    return { disabledReason: `Locked: ${worktree.lockedReason}`, navigable: false };
  }
  return { disabledReason: null, navigable: true };
}

type HeaderControlProps = Omit<ComponentPropsWithRef<typeof Button>, 'children'> & {
  readonly ariaLabel: string;
  readonly icon: ReactElement;
  readonly label: string;
  readonly value: string;
};

function HeaderControl({
  ariaLabel,
  className = '',
  icon,
  label,
  ref,
  value,
  ...triggerProps
}: HeaderControlProps): ReactElement {
  return (
    <Button
      {...triggerProps}
      aria-label={ariaLabel}
      className={`h-14 min-w-0 justify-start gap-2 rounded-none border-border border-r px-3 shadow-none hover:bg-accent/50 ${className}`}
      ref={ref}
      type="button"
      variant="ghost"
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 text-left">
        <span className="block font-medium text-[10px] text-muted-foreground leading-none">
          {label}
        </span>
        <span className="mt-1 block truncate font-semibold text-xs">{value}</span>
      </span>
      <ChevronDown aria-hidden="true" className="ml-auto size-3.5 text-muted-foreground" />
    </Button>
  );
}

export function GitWorkbenchHeader({
  fetchRemote,
  isLoading,
  isSyncing,
  refreshStatus,
  repository,
  status,
  switchBranch,
}: GitWorkbenchHeaderProps): ReactElement {
  const currentRemote = repository.defaultRemote;
  const branchName = status.branch ?? 'Detached HEAD';
  const { available: inventoryAvailable, error: inventoryError, inventory } = useGitInventory();
  const openChangeset = useChangesNavigationStore((state) => state.openChangeset);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);

  // Two-step handoff (same shape as `useChangesReviewValue` in
  // `root-layout-content.tsx`): the Changes surface is a tab inside the
  // workspace panel on the `explorer` route, not a route of its own, so
  // reaching it from the `git` route needs both the changeset write AND the
  // route switch. `git-workbench-header.tsx` already lives in
  // `packages/app-shell` alongside both stores, so it calls them directly
  // rather than through the `ChangesReviewContext` capability-injection seam
  // — that seam exists only because `packages/ui`'s `ChangesReviewLink`
  // cannot import app-shell; it would be a needless indirection here. This
  // mirrors the existing `changes-context-actions.ts`'s
  // `addWorktreeAsRoot` action, which reaches the same store the same way.
  const navigateToWorktreeChanges = (worktreePath: string): void => {
    openChangeset({
      kind: 'git-scope',
      repositoryRoot: repository.repositoryRoot,
      scope: { kind: 'uncommitted' },
      worktreePath,
    });
    setActiveTab('explorer');
  };

  return (
    <div className="flex h-14 shrink-0 border-border border-b bg-card/35">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderControl
            ariaLabel={`Current repository ${repository.name}`}
            className="flex-[1.35]"
            icon={<FolderGit2 aria-hidden="true" className="size-4" />}
            label="Current Repository"
            value={repository.name}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>Repository</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5">
            <div className="truncate font-medium text-sm">{repository.name}</div>
            <div className="mt-0.5 truncate text-muted-foreground text-xs">
              {repository.repositoryRoot}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderControl
            ariaLabel={`Current worktree ${repository.currentWorktree.name}`}
            className="flex-1"
            icon={<FolderTree aria-hidden="true" className="size-4" />}
            label="Current Worktree"
            value={repository.currentWorktree.name}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-96">
          <DropdownMenuLabel>Repository worktrees</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {[
            repository.currentWorktree,
            ...repository.worktrees.filter((item) => !item.current),
          ].map((worktree) => {
            const { disabledReason, navigable } = resolveWorktreeNavigation(
              worktree,
              repository.repositoryRoot,
              inventory,
              inventoryError,
              inventoryAvailable
            );
            const accessibleName = disabledReason
              ? `Review changes in ${worktree.name} — ${disabledReason}`
              : `Review changes in ${worktree.name}`;
            return (
              <span key={worktree.path} title={disabledReason ?? undefined}>
                <DropdownMenuItem
                  aria-label={accessibleName}
                  data-testid="git-workbench-worktree-item"
                  disabled={!navigable}
                  onSelect={() => {
                    if (navigable) {
                      navigateToWorktreeChanges(worktree.path);
                    }
                  }}
                >
                  <span className="flex w-full items-start gap-2">
                    {worktree.current ? (
                      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                    ) : (
                      <span aria-hidden="true" className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-sm">{worktree.name}</span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {worktree.path}
                      </span>
                      <span className="mt-0.5 block text-muted-foreground text-xs">
                        {worktree.branch ?? 'Detached HEAD'}
                      </span>
                      {disabledReason ? (
                        <span
                          className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-300"
                          data-testid="git-workbench-worktree-disabled-reason"
                        >
                          {disabledReason}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </DropdownMenuItem>
              </span>
            );
          })}
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
            Select a worktree to review its uncommitted changes.
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderControl
            ariaLabel={`Current branch ${branchName}`}
            className="flex-1"
            icon={<GitBranch aria-hidden="true" className="size-4" />}
            label="Current Branch"
            value={branchName}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Local branches</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {repository.scope === 'workspace' ? (
            <div className="px-2 py-2 text-muted-foreground text-xs">
              Open the repository root to switch branches.
            </div>
          ) : (
            repository.branches.map((branch) => (
              <DropdownMenuItem
                disabled={branch.current || branch.worktreePath !== null}
                key={branch.name}
                onSelect={() => switchBranch(branch.name)}
              >
                {branch.current ? <Check aria-hidden="true" /> : <span className="size-4" />}
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                {branch.worktreePath && !branch.current ? (
                  <span className="text-[10px] text-muted-foreground">in worktree</span>
                ) : null}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {currentRemote ? (
        <Button
          aria-label={`Fetch ${currentRemote}`}
          className="h-14 min-w-48 justify-start gap-2 rounded-none px-4 shadow-none hover:bg-accent/50"
          disabled={isSyncing}
          onClick={() => fetchRemote(currentRemote)}
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" className={`size-4 ${isSyncing ? 'animate-spin' : ''}`} />
          <span className="text-left">
            <span className="block font-semibold text-xs">Fetch {currentRemote}</span>
            <span className="mt-0.5 block text-[10px] text-muted-foreground">
              Refresh remote references
            </span>
          </span>
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="h-14 min-w-48 justify-start gap-2 rounded-none px-4 shadow-none hover:bg-accent/50"
              disabled={isSyncing || repository.remotes.length === 0}
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              <span className="text-left">
                <span className="block font-semibold text-xs">Fetch remote</span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  Choose an explicit remote
                </span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {repository.remotes.map((remote) => (
              <DropdownMenuItem key={remote} onSelect={() => fetchRemote(remote)}>
                {remote}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        aria-label="Refresh Git status"
        className="h-14 w-14 rounded-none border-border border-l shadow-none hover:bg-accent/50"
        disabled={isLoading}
        onClick={refreshStatus}
        title="Refresh Git status"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" className={isLoading ? 'animate-spin' : ''} />
      </Button>
    </div>
  );
}
