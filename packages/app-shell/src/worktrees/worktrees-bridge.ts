/**
 * Structural typing + capability resolution for the desktop `window.worktrees`
 * bridge (spec §6.1). Mirrors `changes-bridge.ts` exactly.
 *
 * Web never constructs it (there is no preload), so the Mode chip is simply
 * absent there — consumers capability-check this resolver, never `isElectron()`.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  GitResult,
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';

export type {
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeExternalTool,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupOutcome,
} from '@brainstrike/types';

const logger = createLogger('WorktreesBridge');

export interface WorktreesBridge {
  archive: (params: {
    force?: boolean;
    runId?: string;
    worktreeId: string;
  }) => Promise<GitResult<WorktreeArchiveResult>>;
  create: (params: WorktreeCreateParams) => Promise<GitResult<WorktreeCreateResult>>;
  createBranchHere: (params: {
    branch: string;
    worktreeId: string;
  }) => Promise<GitResult<ManagedWorktreeRow>>;
  getSettings: () => Promise<GitResult<WorktreeSettings>>;
  list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
  listManagedPaths: () => Promise<GitResult<readonly ManagedWorktreePathEntry[]>>;
  restore: (params: { worktreeId: string }) => Promise<GitResult<WorktreeCreateResult>>;
  setSettings: (params: {
    managedDirectory: string | null;
    setupCommand: readonly string[] | null;
  }) => Promise<GitResult<WorktreeSettings>>;
}

// Compile-time exact-set proof: a missing key fails the build, an excess key is
// rejected — so the pin can never silently become a subset of the interface.
const WORKTREES_BRIDGE_REQUIRED_METHOD_SET = {
  archive: true,
  create: true,
  createBranchHere: true,
  getSettings: true,
  list: true,
  listManagedPaths: true,
  restore: true,
  setSettings: true,
} as const satisfies Record<keyof WorktreesBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.worktrees` `exposeInMainWorld` key set to this exact list. The pin is
 * EXACT set equality, not a subset check: there is no such thing as an optional
 * bridge method.
 */
export const WORKTREES_BRIDGE_REQUIRED_METHODS = Object.keys(
  WORKTREES_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof WorktreesBridge)[];

/**
 * Resolve `window.worktrees`, or `null` when absent (web) or malformed (a
 * present-but-broken bridge logs an error and stays absent — no silent
 * degradation).
 */
export function resolveWorktreesBridge(): WorktreesBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { worktrees?: Partial<WorktreesBridge> }).worktrees;
  if (!bridge) {
    return null;
  }
  const missing = WORKTREES_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.worktrees bridge is malformed; worktree mode disabled', { missing });
    return null;
  }
  return bridge as WorktreesBridge;
}

/** True when a fully-formed desktop `window.worktrees` bridge is present. */
export function isWorktreesBridgeAvailable(): boolean {
  return resolveWorktreesBridge() !== null;
}
