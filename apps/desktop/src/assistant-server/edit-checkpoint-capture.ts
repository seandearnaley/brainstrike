import fsPromises from 'node:fs/promises';
import type { AssistantEditCheckpointOp, RuntimeData } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import {
  type EditCheckpointCapture,
  type EditCheckpointDatabase,
  recordEditCheckpoint,
  sha256Hex,
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
 * Classification of a file's pre-mutation state, produced without leaning on the
 * text reader so binary/oversized files are recorded honestly (never a truncated
 * snapshot). Binary keeps the hash+size (before-content refused); oversized keeps
 * only the size (we never read past the cap).
 */
export type BeforeState =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'text';
      readonly content: string;
      readonly size: number;
      readonly hash: string;
    }
  | { readonly kind: 'binary'; readonly size: number; readonly hash: string }
  | { readonly kind: 'too_large'; readonly size: number };

/**
 * Read the before-state of `absolutePath` for journaling. `maxBytes` mirrors the
 * write tools' 2 MB cap: a larger file is classified `too_large` WITHOUT being
 * read. A NUL byte in the first 4 KB marks `binary`. Anything else is `text`.
 */
export async function captureBeforeState(
  absolutePath: string,
  maxBytes: number
): Promise<BeforeState> {
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
  const size = Number(stats.size);
  if (size > maxBytes) {
    return { kind: 'too_large', size };
  }
  const buffer = await fsPromises.readFile(absolutePath);
  const probeLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return { hash: sha256Hex(buffer), kind: 'binary', size };
    }
  }
  return { content: buffer.toString('utf8'), hash: sha256Hex(buffer), kind: 'text', size };
}

/**
 * Map a {@link BeforeState} to the journal's before-capture columns. `created`
 * (absent) and the two `skipped_*` degradations are visible-but-unrevertible;
 * only `text` yields a restorable before-content. `rename` is never routed here
 * (no content change).
 */
export function beforeStateToCapture(
  state: BeforeState
): Pick<
  EditCheckpointCapture,
  'beforeExisted' | 'beforeHash' | 'beforeContent' | 'beforeSize' | 'captureStatus'
> {
  switch (state.kind) {
    case 'absent':
      return {
        beforeContent: null,
        beforeExisted: false,
        beforeHash: null,
        beforeSize: null,
        captureStatus: 'created',
      };
    case 'text':
      return {
        beforeContent: state.content,
        beforeExisted: true,
        beforeHash: state.hash,
        beforeSize: state.size,
        captureStatus: 'ok',
      };
    case 'binary':
      return {
        beforeContent: null,
        beforeExisted: true,
        beforeHash: state.hash,
        beforeSize: state.size,
        captureStatus: 'skipped_binary',
      };
    default:
      return {
        beforeContent: null,
        beforeExisted: true,
        beforeHash: null,
        beforeSize: state.size,
        captureStatus: 'skipped_too_large',
      };
  }
}

export interface EditCheckpointCaptureRequest {
  readonly afterExisted: boolean;
  readonly afterHash: string | null;
  readonly before: Pick<
    EditCheckpointCapture,
    'beforeExisted' | 'beforeHash' | 'beforeContent' | 'beforeSize' | 'captureStatus'
  >;
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

/**
 * Record a checkpoint for a completed mutation. GATED on an active memory context
 * (runId + threadId + resourceId) — a non-persisted run / web has no thread_runs
 * row to attach to, so it debug-logs and no-ops (a persistence boundary, not a
 * silent fallback). NON-FATAL to the tool: a DB-absent environment debug-logs; a
 * resolvable DB that then throws error-logs. The tool result is never affected.
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
    await recordEditCheckpoint(db, {
      afterExisted: request.afterExisted,
      afterHash: request.afterHash,
      beforeContent: request.before.beforeContent,
      beforeExisted: request.before.beforeExisted,
      beforeHash: request.before.beforeHash,
      beforeSize: request.before.beforeSize,
      captureStatus: request.before.captureStatus,
      resourceId,
      rootId: request.rootId,
      runId,
      threadId,
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
