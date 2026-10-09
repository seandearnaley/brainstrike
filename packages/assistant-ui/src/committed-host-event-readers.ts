import type { CompleteAttachment } from '@assistant-ui/react';
import type {
  AssistantRunEvent,
  HookSkipNoticeInput,
  RunAttemptNoticeInput,
} from '@brainstrike/assistant-contract';
import {
  readShellOutputStreamPart,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract/shell-output';

/**
 * Readers of committed host events the log projection maps onto the thread:
 * strict field access, and the always-visible timeline notices.
 */

/** A committed row's address: a notice's key, never a new identity. */
interface CommittedRowAddress {
  readonly seq: number;
  readonly threadId: string;
}

export function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) {
    throw new Error(`Committed host event is missing ${key}.`);
  }
  return field;
}

/**
 * A committed `mcp.tools.unavailable` as the run timeline's always-visible
 * notice. Its key is the committed row's address, never a new identity.
 */
export function mcpToolsUnavailableNotice(
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
export function worktreeCreatedNotice(
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

/** A committed stream chunk's data part: a named data chunk, or a shell-output slice. */
export function committedStreamData(
  chunk: Readonly<Record<string, unknown>>
): { readonly data: unknown; readonly name: string } | undefined {
  const type = chunk['type'];
  if ((type === 'data' || type === 'aui-data') && typeof chunk['name'] === 'string') {
    return { data: chunk['data'], name: chunk['name'] };
  }
  const shellOutput = readShellOutputStreamPart(chunk);
  return shellOutput ? { data: shellOutput, name: SHELL_OUTPUT_DATA_NAME } : undefined;
}
