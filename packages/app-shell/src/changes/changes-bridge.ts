/**
 * Structural typing + capability resolution for the desktop `window.changes`
 * bridge (BST-1113/BST-1114).
 *
 * Shared changeset-diff contracts come from `@brainstrike/types`; this
 * interface only describes the capability methods exposed by the desktop
 * preload (backed by `ChangesetDiffService` via the `changes` IPC domain in
 * `apps/desktop/src/changes-ipc-handlers.ts`).
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): a consumer is
 * desktop-only because it is constructed only when `resolveChangesBridge()`
 * returns a fully-formed bridge. Web never sees it — there is no
 * `isElectron()` check anywhere.
 */

import { createLogger } from '@brainstrike/logging';
import type {
  Changeset,
  ChangesetView,
  GitInventory,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';

export type {
  Changeset,
  ChangesetView,
  GitInventory,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';

const logger = createLogger('ChangesBridge');

export interface ChangesBridge {
  fileDiff: (
    rootId: string,
    changeset: Changeset,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  /**
   * Repository/worktree topology across the active workspace roots
   * (BST-1114 T0). Powers the source picker's git scopes and the changed-files
   * tree's root→repo→worktree grouping, and carries each worktree's
   * `trust`/`trustReason` so the UI can state an unvalidated worktree's reason
   * rather than silently degrading.
   */
  inventory: () => Promise<GitResult<GitInventory>>;
  resolveView: (rootId: string, changeset: Changeset) => Promise<GitResult<ChangesetView>>;
}

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.changes` `exposeInMainWorld` key set to this exact list.
 */
export const CHANGES_BRIDGE_REQUIRED_METHODS: readonly (keyof ChangesBridge)[] = [
  'fileDiff',
  'inventory',
  'resolveView',
];

/**
 * Resolve the `window.changes` bridge, or `null` when it is absent (web) or
 * malformed (a present-but-broken bridge logs an error and stays absent — no
 * silent degradation).
 */
export function resolveChangesBridge(): ChangesBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { changes?: Partial<ChangesBridge> }).changes;
  if (!bridge) {
    return null;
  }
  const missing = CHANGES_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.changes bridge is malformed; changes disabled', { missing });
    return null;
  }
  return bridge as ChangesBridge;
}

/** True when a fully-formed desktop `window.changes` bridge is present. */
export function isChangesBridgeAvailable(): boolean {
  return resolveChangesBridge() !== null;
}
