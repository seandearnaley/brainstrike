import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { AssistantEditCheckpointOp, RuntimeData } from '@brainstrike/agent';
import { createDelegatedConversationRepository } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { delegatedHostRunId } from './delegated-host-run-id';
import {
  type EditCheckpointCapture,
  type EditCheckpointDatabase,
  recordEditCheckpoint,
} from './edit-checkpoint-journal';

const logger = createLogger('EditCheckpointJournal');
const REDACTED_PATH = { redacted: true } as const;

function redactError(error: unknown): { code?: string | number; name: string; redacted: true } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return {
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    name: error instanceof Error && error.name.length > 0 ? error.name : typeof error,
    redacted: true,
  };
}

/**
 * A file's pre-mutation identity for the ATTRIBUTION ledger (BST-1164 T4):
 * existence + sha256 + size, never content. Restores come from the turn-start
 * workspace snapshot (`checkpoint-snapshot-undo.ts`), so the content-era
 * classifications — the 2 MB capture cap, `binary`, `too_large` — died with
 * the content capture: every present file hashes the same way.
 */
export type BeforeState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly hash: string; readonly size: number };

/** Streaming sha256 — never buffers the whole file (deletes journal files of
 * ANY size, and the old whole-file read existed only to store content). */
function sha256HexOfFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Read the before-identity of `absolutePath` for journaling: `absent` for a
 * missing path or non-file, otherwise the file's size and streaming sha256.
 */
export async function captureBeforeState(absolutePath: string): Promise<BeforeState> {
  let stats: import('node:fs').Stats;
  try {
    stats = await fsPromises.stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw error;
  }
  if (!stats.isFile()) {
    return { kind: 'absent' };
  }
  return { hash: await sha256HexOfFile(absolutePath), kind: 'present', size: Number(stats.size) };
}

/**
 * Map a {@link BeforeState} to the journal's before-identity columns.
 * `created` (absent before) drives the undo semantics "this edit created the
 * file"; everything else is `ok`. `rename` is never routed here (no content
 * change to identify).
 */
export function beforeStateToCapture(
  state: BeforeState
): Pick<EditCheckpointCapture, 'beforeExisted' | 'beforeHash' | 'beforeSize' | 'captureStatus'> {
  if (state.kind === 'absent') {
    return {
      beforeExisted: false,
      beforeHash: null,
      beforeSize: null,
      captureStatus: 'created',
    };
  }
  return {
    beforeExisted: true,
    beforeHash: state.hash,
    beforeSize: state.size,
    captureStatus: 'ok',
  };
}

export interface EditCheckpointCaptureRequest {
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  readonly before: Pick<
    EditCheckpointCapture,
    'beforeExisted' | 'beforeHash' | 'beforeSize' | 'captureStatus'
  >;
  readonly executionThreadId?: string | undefined;
  readonly fromPath?: string;
  readonly op: AssistantEditCheckpointOp;
  readonly path: string;
  readonly rootId: string;
  readonly runtimeData: RuntimeData | undefined;
  readonly toolCallId: string | undefined;
  readonly toolName: string;
}

export interface EditCheckpointCaptureOptions {
  /** Injected DB handle for tests; production resolves the main-process handle. */
  readonly database?: EditCheckpointDatabase;
}

async function resolveDesktopDatabase(): Promise<EditCheckpointDatabase> {
  const { getDatabase } = await import('../db-main');
  return (await getDatabase()) as unknown as EditCheckpointDatabase;
}

async function checkpointOwner(
  db: EditCheckpointDatabase,
  memory: { runId: string; threadId: string; resourceId: string },
  executionThreadId: string | undefined
): Promise<{ runId: string; threadId: string; resourceId: string }> {
  if (!executionThreadId || executionThreadId === memory.threadId) {
    return memory;
  }
  const scope = { ownerResourceId: memory.resourceId, rootThreadId: memory.threadId };
  const node = await createDelegatedConversationRepository(db).get(scope, executionThreadId);
  if (!node?.parentThreadId) {
    throw new Error('Child edit has no authorized conversation owner.');
  }
  const result = await db.query(
    `SELECT invocation.parent_runtime_run_id AS "parentRuntimeRunId",
    invocation.parent_tool_call_id AS "parentToolCallId",
    invocation.child_runtime_run_id AS "childRuntimeRunId"
    FROM brainstrike_delegated_invocations invocation
    JOIN brainstrike_assistant_thread_runs current_leg ON current_leg.id = $4
      AND current_leg.resource_id = invocation.owner_resource_id
      AND current_leg.thread_id = invocation.root_thread_id
      AND current_leg.turn_message_id = invocation.turn_message_id
    WHERE invocation.owner_resource_id = $1 AND invocation.root_thread_id = $2
      AND invocation.thread_id = $3`,
    [memory.resourceId, memory.threadId, executionThreadId, memory.runId]
  );
  const identity = z
    .object({
      childRuntimeRunId: z.string().min(1),
      parentRuntimeRunId: z.string().min(1),
      parentToolCallId: z.string().min(1),
    })
    .parse(result.rows.length === 1 ? result.rows[0] : undefined);
  return {
    resourceId: node.resourceId,
    runId: delegatedHostRunId(memory.runId, identity),
    threadId: node.threadId,
  };
}

/**
 * Record an attribution row for a completed mutation. GATED on an active
 * memory context (runId + threadId + resourceId) — a non-persisted run / web
 * has no thread_runs row to attach to, so it debug-logs and no-ops (a
 * persistence boundary, not a silent fallback). NON-FATAL to the tool: a
 * DB-absent environment debug-logs; a resolvable DB that then throws
 * error-logs. The tool result is never affected.
 */
export async function recordEditCheckpointForTool(
  request: EditCheckpointCaptureRequest,
  options: EditCheckpointCaptureOptions = {}
): Promise<void> {
  const memory = request.runtimeData?.memory;
  const runId = memory?.runId;
  const threadId = memory?.threadId;
  const resourceId = memory?.resourceId;
  if (!(runId && threadId && resourceId)) {
    logger.debug('Skipped edit checkpoint: no active memory thread', { path: REDACTED_PATH });
    return;
  }

  let db: EditCheckpointDatabase;
  try {
    db = options.database ?? (await resolveDesktopDatabase());
  } catch (error) {
    logger.debug('Skipped edit checkpoint: database unavailable', {
      error: redactError(error),
      path: REDACTED_PATH,
    });
    return;
  }

  try {
    const owner = await checkpointOwner(
      db,
      { resourceId, runId, threadId },
      request.executionThreadId
    );
    await recordEditCheckpoint(db, {
      afterExisted: request.afterExisted,
      afterHash: request.afterHash,
      beforeExisted: request.before.beforeExisted,
      beforeHash: request.before.beforeHash,
      beforeSize: request.before.beforeSize,
      captureStatus: request.before.captureStatus,
      ...owner,
      rootId: request.rootId,
      toolName: request.toolName,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      ...(request.op === 'rename'
        ? { fromPath: request.fromPath ?? '', op: 'rename', path: request.path }
        : { op: request.op, path: request.path }),
    });
  } catch (error) {
    logger.error('Failed to record edit checkpoint; undo will be unavailable for this edit', {
      error: redactError(error),
      path: REDACTED_PATH,
    });
  }
}
