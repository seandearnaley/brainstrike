/**
 * Shared contract for the per-turn edit checkpoint journal (undo of agent file
 * edits). The op + capture_status enums mirror the CHECK constraints in DB
 * migration 051; the record is the read/list DTO surfaced to the renderer.
 *
 * The DTO deliberately OMITS `before_content`: the raw (possibly large) prior
 * file bytes never leave the main process — revert runs in main and reads the
 * row directly. The renderer only needs enough to render Revert button state.
 */

export const ASSISTANT_EDIT_CHECKPOINT_OPS = [
  'write',
  'string_replace',
  'delete',
  'rename',
] as const;

export type AssistantEditCheckpointOp = (typeof ASSISTANT_EDIT_CHECKPOINT_OPS)[number];

export const ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES = [
  'ok',
  'created',
  'skipped_binary',
  'skipped_too_large',
  'expired',
  'rename',
] as const;

export type AssistantEditCheckpointCaptureStatus =
  (typeof ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES)[number];

/**
 * Capture statuses whose before-state is fully recorded, so a revert can restore
 * it. `skipped_binary`/`skipped_too_large`/`expired` are visible-but-unrevertible
 * (before-content was never/no-longer stored).
 */
export const ASSISTANT_EDIT_CHECKPOINT_REVERTIBLE_STATUSES: readonly AssistantEditCheckpointCaptureStatus[] =
  ['ok', 'created', 'rename'];

export function isRevertibleCaptureStatus(status: AssistantEditCheckpointCaptureStatus): boolean {
  return ASSISTANT_EDIT_CHECKPOINT_REVERTIBLE_STATUSES.includes(status);
}

/**
 * Read/list DTO for one journal entry. Timestamps are ISO strings (wire-safe).
 * `revertedAt` non-null ⇒ already reverted (idempotent, non-revertible again).
 */
export interface AssistantEditCheckpointRecord {
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  readonly beforeExisted: boolean;
  readonly beforeHash: string | null;
  readonly beforeSize: number | null;
  readonly captureStatus: AssistantEditCheckpointCaptureStatus;
  /** Rename source only; null for every other op. */
  readonly fromPath: string | null;
  readonly id: string;
  readonly occurredAt: string;
  readonly op: AssistantEditCheckpointOp;
  /** Target path (for a rename this is the destination / to_path). */
  readonly path: string;
  readonly resourceId: string;
  readonly revertedAt: string | null;
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string | null;
  readonly toolName: string;
}

/**
 * Structured outcome of a revert action returned across the IPC boundary — a
 * discriminated result union rather than a thrown error, so the renderer can
 * name the reason (conflict / not-revertible / not-found) without try/catch.
 */
export type AssistantCheckpointRevertResult =
  | { readonly ok: true; readonly entry: AssistantEditCheckpointRecord }
  | {
      readonly ok: false;
      readonly code: 'conflict' | 'not_revertible' | 'not_found';
      readonly message: string;
      readonly id: string;
    };

/**
 * Per-entry outcome for a whole-turn revert. Partial success is honest: one
 * conflicting entry never aborts the others.
 */
export interface AssistantCheckpointRevertRunResult {
  readonly outcomes: readonly AssistantCheckpointRevertResult[];
  readonly runId: string;
}

/**
 * Snapshot-availability of the undo action for ONE journal entry (BST-1164
 * T4 — the snapshot-backed undo engine). `restorable: false` carries the
 * user-facing reason (entry predates workspace snapshots, the turn's capture
 * failed, or its root has no turn-start coverage) so the renderer can show a
 * visibly disabled control instead of a click-time refusal.
 */
export type AssistantCheckpointUndoAvailability =
  | { readonly restorable: true }
  | { readonly reason: string; readonly restorable: false };
