/** Shared renderer/main contract for Brainstrike's local Git workbench. */

/** Discriminated result envelope returned across the desktop IPC boundary. */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

export interface GitDiff {
  readonly path: string | null;
  readonly staged: boolean;
  readonly truncated: boolean;
  readonly unifiedDiff: string;
}

/** Explicit diff source; invalid staged/untracked combinations are unrepresentable. */
export type GitDiffParams =
  | { readonly mode: 'staged'; readonly path?: string }
  | { readonly mode: 'untracked'; readonly path: string }
  | { readonly mode: 'working'; readonly path?: string };

export interface GitAheadBehind {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly hasUpstream: boolean;
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

export interface GitHistoryCommit {
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly authorName: string;
  readonly body: string;
  readonly committedAt: string;
  readonly decoration: string;
  readonly id: string;
  readonly parentIds: readonly string[];
  readonly shortId: string;
  readonly summary: string;
}

export interface GitHistoryPage {
  readonly commits: readonly GitHistoryCommit[];
  readonly hasMore: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface GitCommitFile {
  readonly originalPath?: string;
  readonly path: string;
  readonly status: string;
}

export interface GitSwitchBranchResult {
  readonly branch: string;
}
