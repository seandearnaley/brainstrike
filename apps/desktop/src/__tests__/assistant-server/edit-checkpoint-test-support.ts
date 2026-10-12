import type {
  AssistantEditCheckpointCaptureStatus,
  AssistantEditCheckpointOp,
  AssistantEditCheckpointRecord,
} from '@brainstrike/agent';
import {
  type EditCheckpointDatabase,
  readCheckpointRecord,
} from '../../assistant-server/edit-checkpoint-journal';

/**
 * One `brainstrike_assistant_edit_checkpoints` row for the journal readers and
 * the snapshot undo engine under test. Nothing in production writes the table
 * any more; these suites seed it directly.
 */
export type EditCheckpointRowInput = {
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  readonly beforeExisted: boolean;
  readonly beforeHash: string | null;
  readonly beforeSize: number | null;
  readonly captureStatus: AssistantEditCheckpointCaptureStatus;
  /** Defaults to now. */
  readonly occurredAt?: Date;
  readonly resourceId: string;
  readonly rootId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId?: string;
  readonly toolName: string;
} & (
  | { readonly op: Exclude<AssistantEditCheckpointOp, 'rename'>; readonly path: string }
  | { readonly op: 'rename'; readonly path: string; readonly fromPath: string }
);

/** Inserts one row and returns it as the journal reads it back. */
export async function insertEditCheckpointRow(
  db: EditCheckpointDatabase,
  input: EditCheckpointRowInput
): Promise<AssistantEditCheckpointRecord> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO brainstrike_assistant_edit_checkpoints (
       id, run_id, resource_id, thread_id, tool_call_id, tool_name, op, root_id,
       path, from_path, before_existed, before_hash, before_size,
       after_hash, after_existed, capture_status, occurred_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, NOW(), NOW()
     )`,
    [
      id,
      input.runId,
      input.resourceId,
      input.threadId,
      input.toolCallId ?? null,
      input.toolName,
      input.op,
      input.rootId,
      input.path,
      input.op === 'rename' ? input.fromPath : null,
      input.beforeExisted,
      input.beforeHash,
      input.beforeSize,
      input.afterHash,
      input.afterExisted,
      input.captureStatus,
      (input.occurredAt ?? new Date()).toISOString(),
    ]
  );
  const record = await readCheckpointRecord(db, id);
  if (!record) {
    throw new Error(`Edit checkpoint row ${id} was not inserted.`);
  }
  return record;
}
