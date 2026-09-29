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
 *
 * It carries ONE reason. The companion `runs-table-absent` was retired by
 * BST-1651: it meant "this profile has never recorded an assistant run",
 * inferred from the runs table not existing — a state migration 118 removed.
 * An unmigrated database is not a reason this union reports; it raises.
 */
export type AssistantRewindRange =
  | {
      readonly kind: 'runs';
      readonly fromRunId: string;
      readonly runIds: readonly string[];
    }
  | {
      readonly kind: 'none';
      readonly reason: 'no-runs-after-message';
    };

/**
 * Whether the `conversation-and-files` scope is available for a rewind target
 * (BST-1164 W7 T3, snapshot engine). The files side of a rewind restores from
 * the target turn's `turn-start` workspace snapshot, so a turn with no usable
 * snapshot cannot offer it — but `conversation-only` never depends on capture
 * and stays available. The two unavailable reasons are the carried rulings:
 *
 * - `turn-predates-snapshots`: the thread has NO workspace snapshot rows at
 *   all — it predates the snapshot engine. Conversation-only rewind is
 *   offered with this visible refusal of the files scope; the retired journal
 *   restore engine is never used as a fallback.
 * - `snapshot-missing`: the thread HAS snapshot rows, but the target turn's
 *   `turn-start` coverage is absent or incomplete (its capture failed, or a
 *   root joined the workspace after that turn). The files scope is refused
 *   for the whole range with the reason — never "restore what we can".
 */
export type AssistantRewindFilesScope =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly message: string;
      readonly reason: 'snapshot-missing' | 'turn-predates-snapshots';
    };

/**
 * Pre-apply preview. `view` lists what the files scope WOULD change — the
 * per-root snapshot diff (turn-start snapshot vs live work-tree), the same
 * resolution engine the Changes surface renders — so the modal and the Review
 * panel can never disagree.
 *
 * `conflicts` is advisory here (disk can change between preview and apply);
 * `applyRewind` re-scans and is the authority for the gate.
 *
 * Generating a preview also records a per-root work-tree fingerprint in the
 * main process. `applyRewind` in files mode REQUIRES that fingerprint (see the
 * `preview-required` refusal): the acknowledgment gate binds what this preview
 * SHOWED, so an apply with no recorded preview has nothing to bind to.
 */
export interface AssistantRewindPreview {
  readonly changeset: Changeset | null;
  readonly conflicts: readonly AssistantRewindConflict[];
  /** Availability of the `conversation-and-files` scope for this target. */
  readonly filesScope: AssistantRewindFilesScope;
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
 * `redo-incomplete` refuses to complete a redo when the pre-scan passed clean
 * but one or more files still failed during the actual revert (a TOCTOU change
 * between scan and write). The tombstone batch is left in place — NOT deleted
 * — so the messages stay hidden and the batch remains redoable once the
 * conflicting files are resolved.
 *
 * `preview-required` (BST-1164 W7 T3) refuses a files-mode apply for which no
 * preview fingerprint is recorded in the main process (no preview was
 * generated for this target, or the process restarted since). The
 * acknowledgment gate binds what the preview SHOWED; without a recorded
 * preview there is nothing for it to bind, so the fail-safe answer is "open
 * the preview again", never a blind apply.
 *
 * `turn-predates-snapshots` / `snapshot-missing` refuse the files scope when
 * the target turn has no usable `turn-start` snapshot — see
 * {@link AssistantRewindFilesScope} for the two cases. A redo can also refuse
 * `snapshot-missing` when its batch's `pre-revert` snapshots are absent
 * (a batch that predates the snapshot engine); the batch stays in place.
 */
export interface AssistantRewindRefused {
  readonly conflicts: readonly AssistantRewindConflict[];
  readonly message: string;
  readonly ok: false;
  readonly reason:
    | 'already-tombstoned'
    | 'conflicts-unacknowledged'
    | 'message-not-found'
    | 'preview-required'
    | 'range-unresolvable'
    | 'redo-incomplete'
    | 'rewind-not-found'
    | 'run-in-flight'
    | 'snapshot-missing'
    | 'turn-predates-snapshots'
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
