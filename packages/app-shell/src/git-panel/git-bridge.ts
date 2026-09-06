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

import { createLogger } from '@brainstrike/logging';
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
  GitBranchSummary,
  GitCommitFile,
  GitCommitResult,
  GitCreateBranchResult,
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
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '@brainstrike/types';

const logger = createLogger('GitPanel');

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

// Compile-time exact-set proof: `satisfies Record<keyof GitBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — so the pin can never silently become a subset (or superset) of
// the interface. The runtime pin only checks preload ↔ constant; this closes
// interface ↔ constant.
const GIT_BRIDGE_REQUIRED_METHOD_SET = {
  aheadBehind: true,
  commit: true,
  commitFiles: true,
  createBranch: true,
  diff: true,
  fetch: true,
  history: true,
  pull: true,
  push: true,
  repository: true,
  stage: true,
  status: true,
  structuredFileDiff: true,
  switchBranch: true,
  unstage: true,
} as const satisfies Record<keyof GitBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.git` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 */
export const GIT_BRIDGE_REQUIRED_METHODS = Object.keys(
  GIT_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof GitBridge)[];

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
  const missing = GIT_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
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
