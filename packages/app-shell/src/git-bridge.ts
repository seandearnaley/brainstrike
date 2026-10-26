/**
 * The git capability the workspace bar's branch chip and the Changes header
 * reach through `useGitBridge()` (`workspace-git-services.tsx`).
 *
 * Shared Git domain values come from `@brainstrike/types`; this interface only
 * describes the capability methods the host serves. Web provides no bridge, and
 * every surface built on it is omitted — there is no `isElectron()` check.
 */

import type {
  GitCommitResult,
  GitCreateBranchResult,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
} from '@brainstrike/types';

export interface GitBridge {
  commit: (
    rootId: string,
    params: { description?: string; summary: string }
  ) => Promise<GitResult<GitCommitResult>>;
  createBranch: (
    rootId: string,
    params: { branch: string; startPoint?: string }
  ) => Promise<GitResult<GitCreateBranchResult>>;
  fetch: (rootId: string, params: { remote: string }) => Promise<GitResult<GitPushPullResult>>;
  push: (rootId: string, params?: { remote?: string }) => Promise<GitResult<GitPushPullResult>>;
  repository: (rootId: string) => Promise<GitResult<GitRepository>>;
  status: (rootId: string) => Promise<GitResult<GitStatus>>;
  switchBranch: (
    rootId: string,
    params: { branch: string }
  ) => Promise<GitResult<GitSwitchBranchResult>>;
}
