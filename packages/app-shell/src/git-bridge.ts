/**
 * The git capability the workspace bar's branch chip and the Changes header
 * reach through `useGitBridge()` (`workspace-git-services.tsx`).
 *
 * Shared Git domain values come from `@brainstrike/types`; this interface only
 * describes the capability methods the host serves. Web provides no bridge, and
 * every surface built on it is omitted — there is no `isElectron()` check.
 */

import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  GitCommitResult,
  GitCreateBranchResult,
  GitPushPullResult,
  GitRepository,
  GitStatus,
  GitSwitchBranchResult,
} from '@brainstrike/types';

export interface GitBridge {
  commit: (
    rootId: string,
    params: { description?: string; summary: string }
  ) => Promise<BoundaryResult<GitCommitResult>>;
  createBranch: (
    rootId: string,
    params: { branch: string; startPoint?: string }
  ) => Promise<BoundaryResult<GitCreateBranchResult>>;
  fetch: (rootId: string, params: { remote: string }) => Promise<BoundaryResult<GitPushPullResult>>;
  push: (
    rootId: string,
    params?: { remote?: string }
  ) => Promise<BoundaryResult<GitPushPullResult>>;
  repository: (rootId: string) => Promise<BoundaryResult<GitRepository>>;
  status: (rootId: string) => Promise<BoundaryResult<GitStatus>>;
  switchBranch: (
    rootId: string,
    params: { branch: string }
  ) => Promise<BoundaryResult<GitSwitchBranchResult>>;
}
