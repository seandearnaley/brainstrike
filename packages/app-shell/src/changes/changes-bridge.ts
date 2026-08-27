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

import type {
  AssistantRewindFinalization,
  AssistantRewindMode,
  AssistantRewindPreviewResult,
  AssistantRewindRedoResult,
  AssistantRewindResult,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type {
  Changeset,
  ChangesetView,
  ChangesInvalidationEvent,
  GitInventory,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';

export type {
  Changeset,
  ChangesetView,
  ChangesInvalidationEvent,
  GitInventory,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';

const logger = createLogger('ChangesBridge');

/**
 * Which message a rewind targets. `messageId` is the assistant panel's
 * affordance; `runId` is the Changes header's (Amendment 1 A1.3) — the surface
 * knows a run and never a message, and the main process resolves the one from
 * the other rather than the renderer guessing. Exactly one is accepted.
 */
export type RewindPreviewPayload = { readonly threadId: string } & (
  | { readonly messageId: string; readonly runId?: never }
  | { readonly messageId?: never; readonly runId: string }
);

export interface RewindApplyPayload {
  /**
   * REQUIRED before any part of a conflicted files-mode rewind applies. One
   * conflicting file blocks the WHOLE apply until the user has been shown every
   * named path; there is deliberately no per-file override.
   */
  readonly acknowledgeConflicts?: boolean;
  readonly messageId: string;
  /** Explicit scope choice (Amendment 1) — no default reaches the filesystem. */
  readonly mode: AssistantRewindMode;
  readonly threadId: string;
}

export interface RewindRedoPayload {
  readonly acknowledgeConflicts?: boolean;
  readonly rewindId: string;
}

export interface RewindFinalizePayload {
  readonly threadId: string;
}

export interface ChangesBridge {
  /** Conversation Rewind: apply. See {@link RewindApplyPayload}. */
  applyRewind: (payload: RewindApplyPayload) => Promise<GitResult<AssistantRewindResult>>;
  fileDiff: (
    rootId: string,
    changeset: Changeset,
    path: string
  ) => Promise<GitResult<StructuredFileDiff>>;
  /**
   * Conversation Rewind: end the redo window for a thread (W5 T4b). Fired when
   * a USER-authored message starts a new run. `value.finalized === false` means
   * the thread had no outstanding rewind — the ordinary case, not a failure.
   */
  finalizeRewinds: (
    payload: RewindFinalizePayload
  ) => Promise<GitResult<AssistantRewindFinalization>>;
  /**
   * Repository/worktree topology across the active workspace roots
   * (BST-1114 T0). Powers the source picker's git scopes and the changed-files
   * tree's root→repo→worktree grouping, and carries each worktree's
   * `trust`/`trustReason` so the UI can state an unvalidated worktree's reason
   * rather than silently degrading.
   *
   * `{ maxAgeMs: 0 }` forces a rebuild that STARTED AFTER the call rather than
   * serving (or coalescing onto) a snapshot that predates it — what a caller
   * which just registered a root needs for that root to be discovered and
   * watched (BST-1397). Omit it for the ordinary TTL-cached read.
   */
  inventory: (options?: { readonly maxAgeMs?: number }) => Promise<GitResult<GitInventory>>;
  /**
   * Live-refresh push channel (BST-1161, spec §6): subscribe to
   * `changes:invalidated` events fired when the main-process git-metadata
   * watcher observes external git activity on a repository. Returns the
   * unsubscribe function (terminal `onData` precedent).
   */
  onInvalidated: (listener: (event: ChangesInvalidationEvent) => void) => () => void;
  /** Conversation Rewind: undo the newest rewind, one level, until finalization. */
  redoRewind: (payload: RewindRedoPayload) => Promise<GitResult<AssistantRewindRedoResult>>;
  resolveView: (rootId: string, changeset: Changeset) => Promise<GitResult<ChangesetView>>;
  /** Conversation Rewind: pre-apply preview (range, tombstones, conflicts, view). */
  rewindPreview: (
    payload: RewindPreviewPayload
  ) => Promise<GitResult<AssistantRewindPreviewResult>>;
}

// Compile-time exact-set proof: `satisfies Record<keyof ChangesBridge, true>`
// fails the build if any interface method is missing here, and excess keys are
// rejected — so the pin can never silently become a subset (or superset) of
// the interface. The runtime pin only checks preload ↔ constant; this closes
// interface ↔ constant.
const CHANGES_BRIDGE_REQUIRED_METHOD_SET = {
  applyRewind: true,
  fileDiff: true,
  finalizeRewinds: true,
  inventory: true,
  onInvalidated: true,
  redoRewind: true,
  resolveView: true,
  rewindPreview: true,
} as const satisfies Record<keyof ChangesBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.changes` `exposeInMainWorld` key set to this exact list.
 *
 * NOTE: the pin is EXACT set equality, not a subset check — every method the
 * preload exposes must be listed here. There is no such thing as an optional
 * bridge method: a preload method missing from this list (or vice versa)
 * disables the entire surface via the resolver below.
 *
 * Each rewind method joined this list in the SAME commit that added it to the
 * preload (BST-1115 W5 T4 for preview/apply/redo, T4b for finalize) — a bridge
 * that exposes one on a single side only is malformed, and a malformed bridge
 * is absent, never half-working.
 */
export const CHANGES_BRIDGE_REQUIRED_METHODS = Object.keys(
  CHANGES_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof ChangesBridge)[];

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
