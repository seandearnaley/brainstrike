import type { CompleteAttachment } from '@assistant-ui/react';
import type {
  AssistantRunEvent,
  HookSkipNoticeInput,
  RunAttemptNoticeInput,
} from '@brainstrike/assistant-contract';

/**
 * Readers of committed host events the log projection maps onto the thread:
 * strict field access, and the always-visible timeline notices.
 */

/**
 * Committed host rows and stream chunks the projection keeps verbatim with no
 * part of their own (step boundaries, provider bookkeeping). No renderer draws
 * them.
 */
export const HOST_EVENT_DATA_NAME = 'brainstrike.host-event';
export const HOST_STREAM_DATA_NAME = 'brainstrike.host-stream';

/** A committed row's address: a notice's key, never a new identity. */
interface CommittedRowAddress {
  readonly seq: number;
  readonly threadId: string;
  readonly ts?: number;
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** A committed row the presentation cannot read; the view stops before it. */
export class CommittedRowUnreadableError extends Error {
  constructor(
    row: { readonly event: Readonly<Record<string, unknown>>; readonly seq: number },
    cause: unknown
  ) {
    const kind = [row.event['type'], record(row.event['chunk'])?.['type']]
      .filter((part) => typeof part === 'string')
      .join(' ');
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`This conversation cannot be shown past committed row ${row.seq} (${kind}): ${reason}`, {
      cause,
    });
    this.name = 'CommittedRowUnreadableError';
  }
}

/** An identity, name or host-authored label: a non-empty string. */
export function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) {
    throw new Error(`Committed host event is missing ${key}.`);
  }
  return field;
}

/**
 * Streamed model content, such as a tool input delta: any string. A provider
 * may stream an empty one (OpenRouter opens every call with `arguments: ""`).
 */
export function requiredText(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') {
    throw new Error(`Committed host event is missing ${key}.`);
  }
  return field;
}

/**
 * A committed `mcp.tools.unavailable` as the run timeline's always-visible
 * notice. Its key is the committed row's address, never a new identity.
 */
function mcpToolsUnavailableNotice(
  event: Readonly<Record<string, unknown>>,
  row: CommittedRowAddress,
  runId: string,
  timestamp: string
): AssistantRunEvent {
  const serverName = requiredString(event, 'serverId');
  const reason = requiredString(event, 'reason');
  return {
    detail: `${serverName} skipped for this request — ${reason}`,
    id: `run-event-${row.threadId}-${row.seq}`,
    kind: 'mcp.tools.unavailable',
    label: 'MCP server tools unavailable',
    metadata: { reason, scope: 'server', serverName },
    runId,
    status: 'failed',
    timestamp,
  };
}

/** A committed user message's images, as sent-message attachments. */
export function committedAttachments(
  event: Readonly<Record<string, unknown>>,
  messageId: string
): CompleteAttachment[] | undefined {
  const attachments = event['attachments'];
  if (attachments === undefined) {
    return;
  }
  if (!Array.isArray(attachments)) {
    throw new Error('Committed host attachments must be a list.');
  }
  return attachments.map((attachment: unknown, index): CompleteAttachment => {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      !('type' in attachment && attachment.type === 'image')
    ) {
      throw new Error('A committed host attachment must be an image.');
    }
    const fields = attachment as Readonly<Record<string, unknown>>;
    return {
      content: [{ image: requiredString(fields, 'data'), type: 'image' }],
      contentType: requiredString(fields, 'mediaType'),
      id: `${messageId}:attachment:${index}`,
      name: requiredString(fields, 'name'),
      status: { type: 'complete' },
      type: 'image',
    };
  });
}

/**
 * A committed `worktree.created` as its run's timeline row, exactly as the
 * legacy breadcrumb read (BST-1390): "via shell" in the label, because the
 * host observed this operation rather than performed it. Its key is the
 * committed row's address, never a new identity.
 */
function worktreeCreatedNotice(
  event: Readonly<Record<string, unknown>>,
  row: CommittedRowAddress,
  runId: string,
  timestamp: string
): AssistantRunEvent {
  const branch = event['branch'] === null ? null : requiredString(event, 'branch');
  const path = requiredString(event, 'path');
  const worktreeId = requiredString(event, 'worktreeId');
  const name = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
  return {
    detail: branch ?? 'detached HEAD',
    id: `run-event-${row.threadId}-${row.seq}`,
    kind: 'worktree.created',
    label: `Agent created worktree ${name} (via shell)`,
    metadata: { branch, path, via: 'shell', worktreeId },
    runId,
    status: 'info',
    timestamp,
  };
}

/**
 * Memory the run launched (Mastra's buffered observation) failed after its
 * `run.finished`: the answer's outcome stands, so it is a notice of its own.
 */
function memorySettlementFailedNotice(
  event: Readonly<Record<string, unknown>>,
  row: CommittedRowAddress,
  runId: string,
  timestamp: string
): AssistantRunEvent {
  return {
    detail: requiredString(event, 'detail'),
    id: `run-event-${row.threadId}-${row.seq}`,
    kind: 'memory.observation.failed',
    label: 'Background memory failed after this answer',
    runId,
    status: 'failed',
    timestamp,
  };
}

/**
 * A committed host event that is its run's timeline notice, else undefined.
 * Each sits at its run's creation, except a settlement failure, which commits
 * after the run's end and keeps its own time.
 */
export function committedRunNotice(
  event: Readonly<Record<string, unknown>>,
  row: CommittedRowAddress,
  runCreatedAt: Date
): AssistantRunEvent | undefined {
  const runId = (): string => requiredString(event, 'runId');
  const at = runCreatedAt.toISOString();
  switch (event['type']) {
    case 'mcp.tools.unavailable':
      return mcpToolsUnavailableNotice(event, row, runId(), at);
    case 'worktree.created':
      return worktreeCreatedNotice(event, row, runId(), at);
    case 'memory.settlement.failed':
      return memorySettlementFailedNotice(
        event,
        row,
        runId(),
        new Date(row.ts ?? runCreatedAt.getTime()).toISOString()
      );
    default:
      return;
  }
}

const ATTEMPT_REASONS = new Set<unknown>([
  'context-overflow',
  'empty-response',
  'provider-error',
  'stalled',
]);
const ATTEMPT_REFUSALS = new Set<unknown>(['budget-exhausted', 'tool-parts', 'committed-output']);

/** A committed host `run.attempt` row, read strictly like every other committed event. */
export function readRunAttempt(event: Readonly<Record<string, unknown>>): RunAttemptNoticeInput {
  const { attempt, maxAttempts, reason, recovered, refusal } = event;
  if (
    typeof attempt !== 'number' ||
    typeof maxAttempts !== 'number' ||
    !ATTEMPT_REASONS.has(reason) ||
    typeof recovered !== 'boolean' ||
    (refusal !== undefined && !ATTEMPT_REFUSALS.has(refusal))
  ) {
    throw new Error('Committed run attempt has an unsupported shape.');
  }
  return {
    attempt,
    detail: requiredString(event, 'detail'),
    maxAttempts,
    reason: reason as RunAttemptNoticeInput['reason'],
    recovered,
    ...(refusal === undefined
      ? {}
      : { refusal: refusal as NonNullable<RunAttemptNoticeInput['refusal']> }),
  };
}

const HOOK_SKIP_REASONS = new Set<unknown>([
  'changed',
  'invalid',
  'over-budget',
  'unreadable',
  'untrusted',
]);

/** A committed `hooks.skipped` row's files: at least one, each with a known reason. */
export function readHookSkips(
  event: Readonly<Record<string, unknown>>
): readonly HookSkipNoticeInput[] {
  const files = event['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Committed hooks.skipped names no files.');
  }
  return files.map((entry): HookSkipNoticeInput => {
    const file = record(entry);
    if (!(file && HOOK_SKIP_REASONS.has(file['reason']))) {
      throw new Error('Committed hook skip has an unsupported shape.');
    }
    return {
      detail: requiredString(file, 'detail'),
      path: requiredString(file, 'path'),
      reason: file['reason'] as HookSkipNoticeInput['reason'],
    };
  });
}

/** A committed stream chunk's data part: a named data chunk. Tool telemetry is never committed. */
export function committedStreamData(
  chunk: Readonly<Record<string, unknown>>
): { readonly data: unknown; readonly name: string } | undefined {
  const type = chunk['type'];
  if ((type === 'data' || type === 'aui-data') && typeof chunk['name'] === 'string') {
    return { data: chunk['data'], name: chunk['name'] };
  }
  return;
}
