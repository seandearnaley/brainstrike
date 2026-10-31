// ADR-0029 stage 2: the git cluster every agent host composes; tests import the modules directly.
export { hostShellCorrelation, hostWorktreeToolExecutors } from './executors-worktree.ts';
export {
  createGitWorkspace,
  createWorktreeWorkspace,
  type GitWorkspace,
  type GitWorkspaceOptions,
  type WorktreeWorkspace,
  type WorktreeWorkspaceOptions,
} from './host-git-workspace.ts';
export { defaultManagedWorktreeDirectory } from './worktree-settings.ts';
export type { HostWorktreeServices } from './worktree-tool-dependencies.ts';
