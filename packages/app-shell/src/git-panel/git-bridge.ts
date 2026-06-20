/**
 * Structural typing + capability resolution for the desktop `window.git` bridge.
 *
 * app-shell cannot import `apps/desktop` types, so the bridge shape is mirrored
 * here as the minimal contract the Git panel consumes. It MUST stay in sync with
 * the desktop bridge declared in `apps/desktop/src/types/electron.d.ts` (and the
 * service in `apps/desktop/src/assistant-server/git-service.ts`).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): the panel is desktop-only
 * because it is constructed only when `resolveGitBridge()` returns a fully-formed
 * bridge. Web never sees it — there is no `isElectron()` check anywhere.
 */
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('GitPanel');

/** Discriminated result envelope returned across the IPC boundary (never throws). */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A single changed path in the working tree / index. */
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

export interface GitBridge {
  aheadBehind: (rootId: string) => Promise<GitResult<GitAheadBehind>>;
  commit: (rootId: string, params: { message: string }) => Promise<GitResult<GitCommitResult>>;
  diff: (
    rootId: string,
    params?: { path?: string; staged?: boolean; untracked?: boolean }
  ) => Promise<GitResult<GitDiff>>;
  pull: (rootId: string) => Promise<GitResult<GitPushPullResult>>;
  push: (rootId: string) => Promise<GitResult<GitPushPullResult>>;
  stage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
  status: (rootId: string) => Promise<GitResult<GitStatus>>;
  unstage: (rootId: string, params?: { path?: string }) => Promise<GitResult<null>>;
}

/** Every method name the bridge must expose to be considered fully formed. */
const REQUIRED_METHODS: readonly (keyof GitBridge)[] = [
  'status',
  'diff',
  'stage',
  'unstage',
  'commit',
  'aheadBehind',
  'push',
  'pull',
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
