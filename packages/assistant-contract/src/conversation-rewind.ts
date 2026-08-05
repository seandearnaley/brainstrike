/**
 * Shared contract for Conversation Rewind (BST-1115, W5).
 *
 * Rewind restores a thread to the state it had immediately BEFORE a chosen
 * message: that message and every later one are tombstoned (soft — see
 * migration 080), and, in `conversation-and-files` mode, every agent file edit
 * journaled by the runs that started at or after that message is reverted.
 *
 * SCOPE CHOICE (Amendment 1, binding): the mode is always EXPLICIT. There is
 * no default that silently touches the filesystem — a caller that omits the
 * mode does not compile.
 *
 * ACKNOWLEDGMENT GATE (binding, destructive-seam rule): when the pre-flight
 * scan finds ANY conflict, `applyRewind` in files mode applies NOTHING — not
 * the clean files, not the tombstones — until the caller passes
 * `acknowledgeConflicts: true`. One conflicting file blocks the WHOLE apply.
 * There is deliberately no per-file override.
 */

import type { Changeset, ChangesetView } from '@brainstrike/types';

export const ASSISTANT_REWIND_MODES = ['conversation-only', 'conversation-and-files'] as const;

/**
 * `conversation-only` tombstones messages and nothing else: no range revert, no
 * journal write, no after-capture, and the acknowledgment gate does not apply
 * (nothing reaches disk). `conversation-and-files` additionally performs the
 * coupled file revert.
 */
export type AssistantRewindMode = (typeof ASSISTANT_REWIND_MODES)[number];

export const ASSISTANT_REWIND_CONFLICT_CODES = [
  /** On-disk bytes no longer match the state the journal recorded. */
  'disk-changed',
  /** The inverse mutation needs a free path, but something occupies it. */
  'path-occupied',
  /** The entry's before-state was never stored, or expired out of retention. */
  'capture-unavailable',
  /** The entry's workspace root is no longer connected. */
  'root-unavailable',
] as const;

export type AssistantRewindConflictCode = (typeof ASSISTANT_REWIND_CONFLICT_CODES)[number];

/**
 * One reason a file cannot be reverted cleanly. ALWAYS carries the `path` (the
 * partial-failure honesty rule: every blocked file is named, never summarized
 * as a count) and its owning `rootId` so a multi-root rewind stays legible.
 */
export interface AssistantRewindConflict {
  readonly checkpointId: string;
  readonly code: AssistantRewindConflictCode;
  readonly message: string;
  readonly path: string;
  readonly rootId: string;
  readonly rootLabel: string | null;
}

/**
 * Per-root roll-up of a files-mode rewind. Present for EVERY root the range
 * touches, including a root that produced zero successful reverts and a root
 * that is no longer connected (`rootPath: null`) — the MULTI-ROOT BAR forbids
 * a silently skipped root, so absence from this list is never how a root's
 * outcome is communicated.
 */
export interface AssistantRewindRootOutcome {
  readonly attempted: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly reverted: number;
  readonly rootId: string;
  readonly rootLabel: string | null;
  readonly rootPath: string | null;
}

export const ASSISTANT_REWIND_FILE_OUTCOME_CODES = [
  'reverted',
  'conflict',
  'not_revertible',
  'not_found',
] as const;

export type AssistantRewindFileOutcomeCode = (typeof ASSISTANT_REWIND_FILE_OUTCOME_CODES)[number];

/** Outcome of ONE journal entry's revert, named by path. */
export interface AssistantRewindFileOutcome {
  readonly checkpointId: string;
  readonly code: AssistantRewindFileOutcomeCode;
  readonly message: string | null;
  readonly path: string;
  readonly rootId: string;
}

/**
 * Which runs a rewind covers. `none` is an honest, non-error outcome: a
 * message with no run at or after it simply has no file changes to revert.
 * `runs-table-absent` is reported distinctly from `no-runs-after-message`
 * rather than collapsed into one "nothing to do" — a profile that has never
 * recorded an assistant run is a different fact from a thread whose tail
 * produced no runs.
 */
export type AssistantRewindRange =
  | {
      readonly kind: 'runs';
      readonly fromRunId: string;
      readonly runIds: readonly string[];
    }
  | {
      readonly kind: 'none';
      readonly reason: 'no-runs-after-message' | 'runs-table-absent';
    };

/**
 * Pre-apply preview. `view` is the EXISTING run-range `ChangesetView` — the
 * same resolution the Changes surface already renders, not a second
 * computation — so the modal and the Review panel can never disagree.
 *
 * `conflicts` is advisory here (disk can change between preview and apply);
 * `applyRewind` re-scans and is the authority for the gate.
 */
export interface AssistantRewindPreview {
  readonly changeset: Changeset | null;
  readonly conflicts: readonly AssistantRewindConflict[];
  readonly messageId: string;
  readonly range: AssistantRewindRange;
  readonly threadId: string;
  /** Messages that would be hidden, oldest-first, INCLUDING `messageId`. */
  readonly tombstoneMessageIds: readonly string[];
  readonly view: ChangesetView | null;
}

export interface AssistantRewindApplied {
  readonly fileOutcomes: readonly AssistantRewindFileOutcome[];
  readonly mode: AssistantRewindMode;
  readonly ok: true;
  readonly range: AssistantRewindRange;
  /** Journal revert batch; `null` for a `conversation-only` rewind. */
  readonly revertId: string | null;
  /** Batch identity and redo key. Present in BOTH modes. */
  readonly rewindId: string;
  readonly rootOutcomes: readonly AssistantRewindRootOutcome[];
  readonly tombstonedMessageIds: readonly string[];
}

/**
 * A refusal. `conflicts-unacknowledged` is the destructive-seam gate: NOTHING
 * was applied — no file written, no tombstone row inserted — and the caller
 * must re-issue with `acknowledgeConflicts: true` after showing the user every
 * named path.
 *
 * `run-in-flight` is the other unconditional refusal: a rewind may not run
 * while the thread still has a run that has not reached a terminal status,
 * because reverting files the run is still writing would destroy work in
 * progress and tombstoning messages it is still appending would hide half a
 * turn. The message-level affordance also hides itself while a run is live,
 * but that is the CHEAP half — the entry point on the Changes surface has no
 * assistant-runtime state to read, so the authoritative refusal is the
 * main-process one that produces this reason.
 *
 * `already-tombstoned` refuses a `conversation-and-files` apply whose target
 * messages are ALL already tombstoned by an earlier, still-outstanding rewind
 * (`insertTombstoneBatch`'s `ON CONFLICT DO NOTHING` returns zero rows).
 * Proceeding anyway would revert files under a `rewindId` with no sidecar
 * tombstone row, which makes that revert permanently un-redoable the moment it
 * lands — refused before a single file is touched instead.
 *
 * `range-already-reverted` refuses an apply whose range resolved journal
 * entries but every one of them already carries `reverted_at` (the pre-flight
 * scan excludes them, so nothing would apply) while genuinely nothing needed
 * reverting is reported as a `runs`/`none` range with zero records, never this
 * reason. Reachable only when an earlier rewind over the SAME range was
 * reverted and then redone without clearing the original entries' stamps — the
 * fail-safe response is a named refusal, not a silent `ok: true` with empty
 * `fileOutcomes`.
 *
 * `redo-incomplete` refuses to complete a redo when the pre-scan passed clean
 * but one or more files still failed during the actual revert (a TOCTOU change
 * between scan and write). The tombstone batch is left in place — NOT deleted
 * — so the messages stay hidden and the batch remains redoable once the
 * conflicting files are resolved.
 */
export interface AssistantRewindRefused {
  readonly conflicts: readonly AssistantRewindConflict[];
  readonly message: string;
  readonly ok: false;
  readonly reason:
    | 'already-tombstoned'
    | 'conflicts-unacknowledged'
    | 'message-not-found'
    | 'range-already-reverted'
    | 'range-unresolvable'
    | 'redo-incomplete'
    | 'rewind-not-found'
    | 'run-in-flight'
    | 'not-latest-rewind';
}

export type AssistantRewindPreviewResult =
  | (AssistantRewindPreview & { readonly ok: true })
  | AssistantRewindRefused;

export type AssistantRewindResult = AssistantRewindApplied | AssistantRewindRefused;

export interface AssistantRewindRedone {
  readonly fileOutcomes: readonly AssistantRewindFileOutcome[];
  readonly ok: true;
  readonly restoredMessageIds: readonly string[];
  readonly revertId: string | null;
  readonly rewindId: string;
  readonly rootOutcomes: readonly AssistantRewindRootOutcome[];
}

export type AssistantRewindRedoResult = AssistantRewindRedone | AssistantRewindRefused;

/**
 * Outcome of the finalization hook that runs when the next user message lands
 * in a rewound thread: the tombstoned messages are hard-deleted through
 * Mastra's own `deleteMessages` storage path and the sidecar rows go with
 * them, which is what makes the rewind permanent (redo is one level deep, and
 * only until finalization).
 */
export interface AssistantRewindFinalization {
  readonly deletedMessageIds: readonly string[];
  readonly finalized: boolean;
  readonly rewindIds: readonly string[];
}
