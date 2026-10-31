/**
 * The Changes surface's capability contract (BST-1113/BST-1114).
 *
 * Shared changeset-diff contracts come from `@brainstrike/types`; this
 * interface only describes the capability methods the host serves.
 *
 * Capability gating (CLAUDE.md CONTEXT ACTION SYSTEM): a consumer is
 * constructed only when `useChangesBridge()` (`workspace-git-services.tsx`)
 * returns a bridge. Web provides none — there is no `isElectron()` check
 * anywhere.
 */

import type { AssistantRewindMode } from '@brainstrike/assistant-contract';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
  Changeset,
  ChangesetView,
  ChangesInvalidationEvent,
  GitInventory,
  StructuredFileDiff,
} from '@brainstrike/types';

export type { ChangesInvalidationEvent } from '@brainstrike/types';

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
  fileDiff: (
    rootId: string,
    changeset: Changeset,
    path: string
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  inventory: (options?: { readonly maxAgeMs?: number }) => Promise<BoundaryResult<GitInventory>>;
  onInvalidated: (listener: (event: ChangesInvalidationEvent) => void) => () => void;
  resolveView: (rootId: string, changeset: Changeset) => Promise<BoundaryResult<ChangesetView>>;
}
