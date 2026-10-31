/** Shared renderer/main contract for Brainstrike's local git operations. */

/** A single changed path in the working tree or index. */
export interface GitStatusFile {
  readonly originalPath?: string;
  readonly path: string;
  readonly staged: boolean;
  readonly status: string;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export interface GitStatus {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly files: readonly GitStatusFile[];
  readonly isRepository: boolean;
  readonly upstream: string | null;
}

export interface GitCommitResult {
  readonly branch: string | null;
  readonly commit: string;
}

export interface GitPushPullResult {
  readonly output: string;
}

export interface GitBranchSummary {
  readonly current: boolean;
  readonly head: string;
  readonly name: string;
  readonly upstream: string | null;
  /** Worktree containing this branch, or null when it is not checked out. */
  readonly worktreePath: string | null;
}

export interface GitWorktreeSummary {
  readonly bare: boolean;
  readonly branch: string | null;
  readonly current: boolean;
  readonly detached: boolean;
  readonly head: string | null;
  readonly lockedReason: string | null;
  readonly name: string;
  readonly path: string;
  readonly prunableReason: string | null;
}

export interface GitRepository {
  readonly branches: readonly GitBranchSummary[];
  readonly currentWorktree: GitWorktreeSummary;
  /** Configured remote for the current branch, or null when none is configured. */
  readonly defaultRemote: string | null;
  readonly name: string;
  /** Exact user-authorized workspace root that scopes file and history reads. */
  readonly openedRoot: string;
  readonly remotes: readonly string[];
  /** Main worktree path used as stable repository identity. */
  readonly repositoryRoot: string;
  /** True when the opened workspace is below the Git worktree root. */
  readonly scope: 'repository' | 'workspace';
  readonly worktrees: readonly GitWorktreeSummary[];
}

export interface GitCommitFile {
  readonly originalPath?: string;
  readonly path: string;
  readonly status: string;
}

export interface GitSwitchBranchResult {
  readonly branch: string;
}

export interface GitCreateBranchResult {
  readonly branch: string;
}
