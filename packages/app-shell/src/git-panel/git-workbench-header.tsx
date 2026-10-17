import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { GitInventory, GitInventoryRepository, WorktreeDescriptor } from '@brainstrike/types';
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
import {
  buildBranchSwitchModel,
  DIRTY_REASON,
  deriveBranchSwitchDirty,
} from './branch-switch-model';
import type { GitRepository, GitResult, GitStatus, GitWorktreeSummary } from './git-bridge';
import { GitFolderSwitchMenuItems } from './git-folder-switcher';
import type { GitWorkspaceFolder } from './use-git-panel';

interface GitWorkbenchHeaderProps {
  readonly fetchRemote: (remote: string) => Promise<void>;
  readonly focusedFolder: GitWorkspaceFolder;
  readonly focusFolder: (rootId: string) => void;
  readonly isLoading: boolean;
  readonly isSyncing: boolean;
  readonly probeFolder: (rootId: string) => Promise<GitResult<GitStatus>>;
  readonly refreshStatus: () => void;
  readonly repository: GitRepository;
  readonly status: GitStatus;
  readonly switchBranch: (branch: string) => Promise<void>;
  readonly workspaceFolders: readonly GitWorkspaceFolder[];
}

/**
 * PATH VOCABULARY (BST-1116 W6 review finding 2) — the reason this file never
 * compares a `window.git` path against a `window.changes` path.
 *
 * The two bridges canonicalise differently:
 *
 * - `window.git`'s `GitRepository.repositoryRoot`, `currentWorktree.path` and
 *   `worktrees[].path` are RAW `git` output. `git worktree list` prints the
 *   `.git/worktrees/<name>/gitdir` contents verbatim and never realpaths them
 *   (`git-inventory-service.ts` documents this at length as the reason it
 *   realpaths every one itself), and `repositoryRoot` is likewise the raw
 *   worktree root git reported.
 * - the `window.changes` inventory is canonical THROUGHOUT:
 *   `identity.repositoryRoot` is `realpath(mainWorktree.path)` and
 *   `WorktreeDescriptor.path` deliberately OVERWRITES the raw
 *   `GitWorktreeSummary.path` with its realpath — whose own doc comment warns
 *   consumers never to compare the two without realpathing first.
 *
 * The previous implementation did exactly that comparison, string-equal, on
 * both fields. Reach any repository through a symlink and every entry falls
 * into "not in the inventory", disabling the whole feature while looking like
 * it works — the silent-disable class this review round exists to remove.
 *
 * `GitRepository.openedRoot` is the ONE field canonical on both sides:
 * `git-service.ts`'s `createRepositorySnapshot` computes it as
 * `realpath(resolveRootCwd(rootId))`. So the panel's repository is located in
 * the inventory by CONTAINMENT of `openedRoot` under a canonical descriptor
 * path (equal to it, or below it for a `scope: 'workspace'` subfolder root),
 * and every dropdown entry is then driven from that inventory repository's
 * OWN descriptors — path, name, branch, lock state, trust and containment all
 * from one vocabulary. The published changeset uses the canonical
 * `identity.repositoryRoot` too, which is what `changeset-header.tsx` and
 * `changeset-source-picker.tsx` cross-reference the inventory with (`!==` on
 * `identity.repositoryRoot`) once the Changes surface receives it.
 */
function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

/** True when `candidate` IS `container` or sits below it. */
function isWithin(candidate: string, container: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedContainer = normalizePath(container);
  return (
    normalizedCandidate === normalizedContainer ||
    normalizedCandidate.startsWith(`${normalizedContainer}/`)
  );
}

interface InventoryMatch {
  readonly repository: GitInventoryRepository;
  /** The descriptor whose tree contains `openedRoot` — this panel's worktree. */
  readonly worktree: WorktreeDescriptor;
}

/**
 * Locate the panel's repository in the inventory by `openedRoot` containment.
 * The DEEPEST containing worktree wins, so a worktree nested inside another
 * repository's tree resolves to itself rather than to its ancestor — a
 * deterministic choice, never an arbitrary first-match.
 */
function findInventoryMatch(inventory: GitInventory, openedRoot: string): InventoryMatch | null {
  let best: InventoryMatch | null = null;
  for (const repository of inventory.repositories) {
    for (const worktree of repository.worktrees) {
      if (!isWithin(openedRoot, worktree.path)) {
        continue;
      }
      if (
        best === null ||
        normalizePath(worktree.path).length > normalizePath(best.worktree.path).length
      ) {
        best = { repository, worktree };
      }
    }
  }
  return best;
}

type InventoryResolution =
  | {
      readonly kind: 'resolved';
      readonly match: InventoryMatch;
    }
  | {
      readonly kind: 'unavailable';
      /** Stated verbatim on every entry — never a silent disable. */
      readonly reason: string;
    };

/**
 * Resolve the inventory for THIS repository, or state why it could not be.
 * Ordered most-specific-cause first; each reason must be TRUE of the state it
 * describes, and — now that the dropdown re-reads the inventory on open and
 * the panel's refresh control also refreshes it (W6 review finding 4) — must
 * tell a user who can fix the state how.
 */
function resolveInventory(
  inventory: GitInventory | null,
  inventoryError: string | null,
  inventoryAvailable: boolean,
  inventoryLoading: boolean,
  openedRoot: string
): InventoryResolution {
  // Checked FIRST: without a `window.changes` bridge `useGitInventory`
  // reports `inventory: null` with `error: null` forever, which the
  // not-yet-loaded branch below would render as a permanent "Loading…" —
  // a stated reason that is simply false. (`git` and `changes` are
  // independently gated in `preload.ts`'s `shouldExposeBridge`, so one can
  // be present without the other.) No refresh can fix this one, so this is
  // the one reason that does not offer a remedy.
  if (!inventoryAvailable) {
    return { kind: 'unavailable', reason: 'Repository inventory is unavailable in this build.' };
  }
  if (inventoryError) {
    return {
      kind: 'unavailable',
      reason: `Repository inventory unavailable: ${inventoryError}. Reopen this menu or use Refresh Git status to retry.`,
    };
  }
  if (!inventory) {
    // `loading` distinguishes the two `inventory === null` states that the
    // deferred initial load (finding 4) makes separately reachable: a scan is
    // genuinely in flight, versus one has never been requested. Calling the
    // second "Loading…" would be the same false-forever statement the
    // `available` branch above exists to avoid.
    return inventoryLoading
      ? { kind: 'unavailable', reason: 'Loading repository inventory…' }
      : {
          kind: 'unavailable',
          reason: 'Repository inventory has not been read yet — use Refresh Git status to load it.',
        };
  }
  const match = findInventoryMatch(inventory, openedRoot);
  if (!match) {
    return {
      kind: 'unavailable',
      reason:
        'This repository is not in the workspace inventory yet — use Refresh Git status to rescan.',
    };
  }
  return { kind: 'resolved', match };
}

interface WorktreeNavigation {
  /** Non-null exactly when `navigable` is false — states WHY, never a silent disable. */
  readonly disabledReason: string | null;
  readonly navigable: boolean;
}

/**
 * Trust-gates one inventory worktree descriptor (BST-1116 Task C). NO SILENT
 * FALLBACKS: an out-of-root, unvalidated or locked worktree is disabled with
 * a stated reason, never quietly enabled or hidden. Mirrors
 * `changeset-source-picker.tsx`'s worktree gating (same `outside-roots` copy)
 * plus the lock/trust checks this task brief requires.
 */
function resolveWorktreeNavigation(worktree: WorktreeDescriptor): WorktreeNavigation {
  // `trust: 'unvalidated'` only ever occurs for an `outside-roots` worktree
  // (see `WorktreeDescriptor.trust`'s doc comment), so this branch is
  // strictly narrower than the containment check below — checked first for
  // its more specific, bidirectional-check-derived reason.
  if (worktree.trust === 'unvalidated') {
    return {
      disabledReason:
        worktree.trustReason ?? 'This worktree could not be verified against its own .git.',
      navigable: false,
    };
  }
  if (worktree.containment === 'outside-roots') {
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

/** One rendered dropdown row, already gated. */
interface WorktreeEntry {
  readonly branch: string | null;
  readonly current: boolean;
  readonly disabledReason: string | null;
  readonly name: string;
  readonly navigable: boolean;
  readonly path: string;
  /** The canonical target to publish, or null when the row is not navigable. */
  readonly target: { readonly repositoryRoot: string; readonly worktreePath: string } | null;
}

/**
 * Build the dropdown rows.
 *
 * RESOLVED: rows come from the inventory descriptors alone, this panel's own
 * worktree first. `current` is `descriptor === match.worktree` rather than
 * `descriptor.current`, because the latter is computed against the INVENTORY
 * scan's cwd, not against the root this panel actually has open.
 *
 * UNAVAILABLE: the `window.git` worktree list is still rendered, every row
 * disabled and carrying the resolution's stated reason. Hiding the rows would
 * be a silent disable; enabling them would mean navigating on a raw path we
 * have not been able to canonicalise. Showing them, disabled, with the reason
 * and its remedy, is the only honest option.
 */
function buildWorktreeEntries(
  resolution: InventoryResolution,
  repository: GitRepository
): readonly WorktreeEntry[] {
  if (resolution.kind === 'unavailable') {
    return [
      repository.currentWorktree,
      ...repository.worktrees.filter((item) => !item.current),
    ].map((worktree: GitWorktreeSummary) => ({
      branch: worktree.branch,
      current: worktree.current,
      disabledReason: resolution.reason,
      name: worktree.name,
      navigable: false,
      path: worktree.path,
      target: null,
    }));
  }
  const { match } = resolution;
  const ordered = [
    match.worktree,
    ...match.repository.worktrees.filter((item) => item !== match.worktree),
  ];
  return ordered.map((worktree) => {
    const { disabledReason, navigable } = resolveWorktreeNavigation(worktree);
    return {
      branch: worktree.branch,
      current: worktree === match.worktree,
      disabledReason,
      name: worktree.name,
      navigable,
      path: worktree.path,
      target: navigable
        ? {
            repositoryRoot: match.repository.identity.repositoryRoot,
            worktreePath: worktree.path,
          }
        : null,
    };
  });
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
  focusedFolder,
  focusFolder,
  isLoading,
  isSyncing,
  probeFolder,
  refreshStatus,
  repository,
  status,
  switchBranch,
  workspaceFolders,
}: GitWorkbenchHeaderProps): ReactElement {
  const currentRemote = repository.defaultRemote;
  const branchName = status.branch ?? 'Detached HEAD';
  // DEFERRED (BST-1116 W6 review finding 4): mounting the git panel used to
  // trigger a full repo/worktree scan across every workspace root even when
  // the worktree dropdown was never opened. The load now happens on the
  // gesture that reveals the data (`onOpenChange` below) — and `refresh` is
  // ALSO wired into the panel's own refresh control and its branch switch, so
  // an inventory that has gone stale can actually be corrected instead of
  // being permanently wrong behind honest-but-useless copy.
  const {
    available: inventoryAvailable,
    error: inventoryError,
    inventory,
    loading: inventoryLoading,
    refresh: refreshInventory,
  } = useGitInventory({ deferInitialLoad: true });
  const openChangeset = useChangesNavigationStore((state) => state.openChangeset);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);

  const inventoryResolution = resolveInventory(
    inventory,
    inventoryError,
    inventoryAvailable,
    inventoryLoading,
    repository.openedRoot
  );
  const worktreeEntries = buildWorktreeEntries(inventoryResolution, repository);

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
  //
  // Both published paths are the INVENTORY's canonical ones (see this file's
  // PATH VOCABULARY comment), never `window.git`'s raw report: the Changes
  // surface matches `changeset.repositoryRoot` against
  // `identity.repositoryRoot` with `!==`, so a raw root would leave its
  // header and source picker unable to find the repository they were just
  // navigated to.
  const navigateToWorktreeChanges = (target: {
    readonly repositoryRoot: string;
    readonly worktreePath: string;
  }): void => {
    openChangeset({
      kind: 'git-scope',
      repositoryRoot: target.repositoryRoot,
      scope: { kind: 'uncommitted' },
      worktreePath: target.worktreePath,
    });
    setActiveTab('explorer');
  };

  const refreshAll = (): void => {
    refreshStatus();
    void refreshInventory();
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
        <DropdownMenuContent align="start" className="w-96">
          <DropdownMenuLabel>Repository</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5">
            <div className="truncate font-medium text-sm">{repository.name}</div>
            <div className="mt-0.5 truncate text-muted-foreground text-xs">
              {repository.repositoryRoot}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Focused folder</DropdownMenuLabel>
          <div className="px-2 pb-1.5" data-testid="git-workbench-focused-folder">
            <div className="truncate font-medium text-sm">{focusedFolder.name}</div>
            <div
              className="mt-0.5 truncate text-muted-foreground text-xs"
              title={focusedFolder.path}
            >
              {focusedFolder.path}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Show another workspace folder</DropdownMenuLabel>
          <GitFolderSwitchMenuItems
            focusedRootId={focusedFolder.rootId}
            folders={workspaceFolders}
            onSelect={focusFolder}
            probe={probeFolder}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu
        onOpenChange={(open) => {
          // The deferred initial load AND the staleness correction, in one
          // seam: the first open reads the inventory, every later open
          // re-reads it (the main process caches and its git-metadata watcher
          // invalidates that cache, so a repeat open is cheap).
          if (open) {
            void refreshInventory();
          }
        }}
      >
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
          {worktreeEntries.map((worktree) => {
            const { disabledReason, navigable, target } = worktree;
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
                    if (target) {
                      navigateToWorktreeChanges(target);
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
                          className="mt-0.5 block text-[10px] text-warning"
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
          {(() => {
            const model = buildBranchSwitchModel({
              branches: repository.branches,
              dirty: deriveBranchSwitchDirty(status),
              query: '',
              scope: repository.scope,
            });
            if (model.scopeReason) {
              return (
                <div className="px-2 py-2 text-muted-foreground text-xs">{model.scopeReason}</div>
              );
            }
            return (
              <>
                {model.dirty ? (
                  <div
                    className="px-2 py-1.5 text-muted-foreground text-xs"
                    data-testid="git-workbench-branch-dirty-reason"
                  >
                    {DIRTY_REASON}
                  </div>
                ) : null}
                {model.rows.map((row) => (
                  <DropdownMenuItem
                    disabled={!row.switchable}
                    key={row.name}
                    // Worktree-affecting mutation: switching a branch changes this
                    // worktree's `branch`/`head`, which the dropdown reads out of
                    // the inventory. Refresh it after the switch lands so the next
                    // open does not describe the pre-switch topology.
                    onSelect={() => {
                      void switchBranch(row.name).then(() => refreshInventory());
                    }}
                    title={row.disabledReason ?? undefined}
                  >
                    {row.current ? <Check aria-hidden="true" /> : <span className="size-4" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.name}</span>
                      {row.worktreeName ? (
                        <span
                          className="mt-0.5 block whitespace-normal text-[10px] text-muted-foreground"
                          data-testid="git-workbench-branch-disabled-reason"
                        >
                          {row.disabledReason}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            );
          })()}
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
        onClick={refreshAll}
        title="Refresh Git status"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" className={isLoading ? 'animate-spin' : ''} />
      </Button>
    </div>
  );
}
