/**
 * Structural typing + capability resolution for the desktop `window.git` bridge.
 *
 * Shared Git domain values come from `@brainstrike/types`; this interface only
 * describes the capability methods exposed by the desktop preload.
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): the panel is desktop-only
 * because it is constructed only when `resolveGitBridge()` returns a fully-formed
 * bridge. Web never sees it — there is no `isElectron()` check anywhere.
 */

import type {
  GitAheadBehind,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitDiffParams,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitSwitchBranchResult,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';

export type {
  GitAheadBehind,
  GitBranchSummary,
  GitCommitFile,
  GitCommitResult,
  GitDiff,
  GitDiffParams,
  GitHistoryCommit,
  GitHistoryPage,
  GitPushPullResult,
  GitRepository,
  GitResult,
  GitStatus,
  GitStatusFile,
  GitSwitchBranchResult,
  GitWorktreeSummary,
} from '@brainstrike/types';

const logger = createLogger('GitPanel');

export interface GitBridge {
  aheadBehind: (rootId: string) => Promise<GitResult<GitAheadBehind>>;
  commit: (
    rootId: string,
    params: { description?: string; summary: string }
  ) => Promise<GitResult<GitCommitResult>>;
  commitDiff: (
    rootId: string,
    params: { commit: string; originalPath?: string; path: string }
  ) => Promise<GitResult<GitDiff>>;
  commitFiles: (
    rootId: string,
    params: { commit: string }
  ) => Promise<GitResult<readonly GitCommitFile[]>>;
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
  switchBranch: (
    rootId: string,
    params: { branch: string }
  ) => Promise<GitResult<GitSwitchBranchResult>>;
  unstage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
}

/** Every method name the bridge must expose to be considered fully formed. */
const REQUIRED_METHODS: readonly (keyof GitBridge)[] = [
  'status',
  'diff',
  'commitDiff',
  'commitFiles',
  'stage',
  'unstage',
  'commit',
  'aheadBehind',
  'fetch',
  'history',
  'push',
  'pull',
  'repository',
  'switchBranch',
];

/**
 * Resolve the `window.git` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolveGitBridge(): GitBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { git?: Partial<GitBridge> }).git;
  if (!bridge) {
    return null;
  }
  const missing = REQUIRED_METHODS.filter((method) => typeof bridge[method] !== 'function');
  if (missing.length > 0) {
    logger.error('window.git bridge is malformed; Git panel disabled', { missing });
    return null;
  }
  return bridge as GitBridge;
}

/** True when a fully-formed desktop `window.git` bridge is present. */
export function isGitBridgeAvailable(): boolean {
  return resolveGitBridge() !== null;
}
