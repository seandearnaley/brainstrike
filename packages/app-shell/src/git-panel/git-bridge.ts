/**
 * The Git panel's capability contract.
 *
 * Shared Git domain values come from `@brainstrike/types`; this interface only
 * describes the capability methods the host serves.
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): the panel is mounted only
 * when `useGitBridge()` (`workspace-git-services.tsx`) returns a bridge. Web
 * provides none — there is no `isElectron()` check anywhere.
 */

import type {
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitCreateBranchResult,
  GitDiff,
  GitDiffParams,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';

export type {
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitHistoryCommit,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitStatusFile,
  GitWorktreeSummary,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';

export interface GitBridge {
  aheadBehind: (rootId: string) => Promise<GitResult<GitAheadBehind>>;
  commit: (
    rootId: string,
    params: { description?: string; summary: string }
  ) => Promise<GitResult<GitCommitResult>>;
  commitFiles: (
    rootId: string,
    params: { commit: string }
  ) => Promise<GitResult<readonly GitCommitFile[]>>;
  createBranch: (
    rootId: string,
    params: { branch: string; startPoint?: string }
  ) => Promise<GitResult<GitCreateBranchResult>>;
  diff: (rootId: string, params: GitDiffParams) => Promise<GitResult<GitDiff>>;
  fetch: (rootId: string, params: { remote: string }) => Promise<GitResult<GitPushPullResult>>;
  history: (
    rootId: string,
    params: { limit: number; offset: number; ref?: string }
  ) => Promise<GitResult<GitHistoryPage>>;
  pull: (rootId: string) => Promise<GitResult<GitPushPullResult>>;
  push: (rootId: string, params?: { remote?: string }) => Promise<GitResult<GitPushPullResult>>;
  repository: (rootId: string) => Promise<GitResult<GitRepository>>;
  stage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
  status: (rootId: string) => Promise<GitResult<GitStatus>>;
  structuredFileDiff: (
    rootId: string,
    params: StructuredFileDiffParams
  ) => Promise<GitResult<StructuredFileDiff>>;
  switchBranch: (
    rootId: string,
    params: { branch: string }
  ) => Promise<GitResult<GitSwitchBranchResult>>;
  unstage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
}
