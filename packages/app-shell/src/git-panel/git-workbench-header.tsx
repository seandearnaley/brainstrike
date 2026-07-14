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
import type { GitRepository, GitStatus } from './git-bridge';

interface GitWorkbenchHeaderProps {
  readonly fetchRemote: (remote: string) => Promise<void>;
  readonly isLoading: boolean;
  readonly isSyncing: boolean;
  readonly refreshStatus: () => void;
  readonly repository: GitRepository;
  readonly status: GitStatus;
  readonly switchBranch: (branch: string) => Promise<void>;
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
          ].map((worktree) => (
            <div className="flex items-start gap-2 px-2 py-2" key={worktree.path}>
              {worktree.current ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <span aria-hidden="true" className="size-4 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium text-sm">{worktree.name}</div>
                <div className="truncate text-muted-foreground text-xs">{worktree.path}</div>
                <div className="mt-0.5 text-muted-foreground text-xs">
                  {worktree.branch ?? 'Detached HEAD'}
                </div>
              </div>
            </div>
          ))}
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-muted-foreground text-xs leading-relaxed">
            Open the worktree as a workspace to activate it.
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
