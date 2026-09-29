import type { ThreadAssistantMessagePart } from '@assistant-ui/react';

export const ASSISTANT_STREAM_EVENT_ID_HEADER = 'X-Brainstrike-Assistant-Event-Id';
export const ASSISTANT_STREAM_MESSAGE_ID_HEADER = 'X-Brainstrike-Assistant-Message-Id';
export const ASSISTANT_STREAM_RESUME_PATH = '/assistant/resume';
export const ASSISTANT_RUN_STATUS_PATH = '/assistant/run-status';
export const ASSISTANT_ACTIVE_RUN_PATH = '/assistant/active-run';

/**
 * Durable run status projection served by GET ASSISTANT_RUN_STATUS_PATH.
 * `unknown` means the durable row does not exist — for a runId taken from a
 * stored reattachment record that is proof the record is stale, because runs
 * gain their durable row before any stream response can mint a record.
 */
export type AssistantRunStatusProjection =
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'running'
  | 'unknown';

export interface AssistantRunStatusResponse {
  readonly runId: string;
  readonly status: AssistantRunStatusProjection;
}

const RUN_STATUS_PROJECTIONS: readonly AssistantRunStatusProjection[] = [
  'cancelling',
  'cancelled',
  'completed',
  'failed',
  'running',
  'unknown',
];

export function isAssistantRunStatusResponse(value: unknown): value is AssistantRunStatusResponse {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['runId'] === 'string' &&
    record['runId'].trim().length > 0 &&
    typeof record['status'] === 'string' &&
    (RUN_STATUS_PROJECTIONS as readonly string[]).includes(record['status'])
  );
}

export interface AssistantActiveRunSession {
  readonly assistantMessageId: string;
  readonly eventId: string;
  /** Exact runtime parent at admission, for replay before the assistant row is durable. */
  readonly parentMessageId?: string | null;
  readonly runId: string;
}

export function isAssistantActiveRunSession(value: unknown): value is AssistantActiveRunSession {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ['assistantMessageId', 'eventId', 'parentMessageId', 'runId'].includes(key)
    ) &&
    Object.keys(record).length === (Object.hasOwn(record, 'parentMessageId') ? 4 : 3) &&
    typeof record['assistantMessageId'] === 'string' &&
    record['assistantMessageId'].trim().length > 0 &&
    typeof record['eventId'] === 'string' &&
    record['eventId'].trim().length > 0 &&
    (!Object.hasOwn(record, 'parentMessageId') ||
      record['parentMessageId'] === null ||
      (typeof record['parentMessageId'] === 'string' &&
        record['parentMessageId'].trim().length > 0)) &&
    typeof record['runId'] === 'string' &&
    record['runId'].trim().length > 0
  );
}

export interface AssistantActiveRunInputMessage {
  readonly id: string;
  readonly parts: readonly (
    | { readonly type: 'text'; readonly text: string }
    | {
        readonly type: 'file';
        readonly data: string;
        readonly mediaType: string;
        readonly filename?: string;
      }
  )[];
  readonly role: 'user';
}

export interface AssistantDiscoveredRun extends AssistantActiveRunSession {
  /** Immutable persisted prefix captured before an approval/suspend resume started. */
  readonly actionReplay?: {
    readonly pausedMessageId: string;
    readonly pausedParentMessageId: string | null;
    readonly prefixContent: readonly Extract<
      ThreadAssistantMessagePart,
      { type: 'text' | 'reasoning' | 'tool-call' | 'data' }
    >[];
    readonly syntheticPauseMessageId: string;
  };
  readonly inputMessage: AssistantActiveRunInputMessage | null;
  readonly inputParentMessageId: string | null;
  /** Source session is still producing, or closed but retained for replay. */
  readonly state: 'active' | 'closed';
}

export type AssistantActiveRunDiscoveryResponse =
  | { readonly activeRun: AssistantDiscoveredRun | null }
  | { readonly activeRun: null; readonly initializing: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDiscoveryInputPart(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value['type'] === 'text') {
    return (
      Object.keys(value).every((key) => ['type', 'text'].includes(key)) &&
      typeof value['text'] === 'string'
    );
  }
  return (
    value['type'] === 'file' &&
    typeof value['data'] === 'string' &&
    typeof value['mediaType'] === 'string' &&
    Object.keys(value).every((key) => ['type', 'data', 'mediaType', 'filename'].includes(key)) &&
    (value['filename'] === undefined || typeof value['filename'] === 'string')
  );
}

function isDiscoveryInputMessage(value: unknown): value is AssistantActiveRunInputMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Object.keys(value).every((key) => ['id', 'role', 'parts'].includes(key)) &&
    typeof value['id'] === 'string' &&
    value['id'].trim().length > 0 &&
    value['role'] === 'user' &&
    Array.isArray(value['parts']) &&
    value['parts'].every(isDiscoveryInputPart)
  );
}

function isDiscoveredRun(value: unknown): value is AssistantDiscoveredRun {
  if (!isRecord(value)) {
    return false;
  }
  const session = {
    assistantMessageId: value['assistantMessageId'],
    eventId: value['eventId'],
    ...(Object.hasOwn(value, 'parentMessageId')
      ? { parentMessageId: value['parentMessageId'] }
      : {}),
    runId: value['runId'],
  };
  if (!isAssistantActiveRunSession(session)) {
    return false;
  }
  if (
    (value['state'] !== 'active' && value['state'] !== 'closed') ||
    !Object.hasOwn(value, 'inputMessage') ||
    !Object.hasOwn(value, 'inputParentMessageId') ||
    Object.keys(value).some(
      (key) =>
        ![
          'assistantMessageId',
          'eventId',
          'parentMessageId',
          'runId',
          'state',
          'inputMessage',
          'inputParentMessageId',
          'actionReplay',
        ].includes(key)
    )
  ) {
    return false;
  }
  const inputParentMessageId = value['inputParentMessageId'];
  if (
    inputParentMessageId !== null &&
    !(typeof inputParentMessageId === 'string' && inputParentMessageId.trim().length > 0)
  ) {
    return false;
  }
  const input = value['inputMessage'];
  const actionReplay = value['actionReplay'];
  if (actionReplay !== undefined && !isActionReplay(actionReplay)) {
    return false;
  }
  if (actionReplay !== undefined && (input !== null || Object.hasOwn(value, 'parentMessageId'))) {
    return false;
  }
  if (input === null) {
    return inputParentMessageId === null;
  }
  return (
    isDiscoveryInputMessage(input) &&
    Object.hasOwn(value, 'parentMessageId') &&
    input.id === value['parentMessageId']
  );
}

function isActionReplay(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    Object.keys(value).length !== 4 ||
    !Object.keys(value).every((key) =>
      [
        'pausedMessageId',
        'pausedParentMessageId',
        'prefixContent',
        'syntheticPauseMessageId',
      ].includes(key)
    ) ||
    typeof value['pausedMessageId'] !== 'string' ||
    value['pausedMessageId'].trim().length === 0 ||
    typeof value['syntheticPauseMessageId'] !== 'string' ||
    value['syntheticPauseMessageId'].trim().length === 0 ||
    (value['pausedParentMessageId'] !== null &&
      (typeof value['pausedParentMessageId'] !== 'string' ||
        value['pausedParentMessageId'].trim().length === 0)) ||
    !Array.isArray(value['prefixContent'])
  ) {
    return false;
  }
  return value['prefixContent'].every((part: unknown) => {
    if (!isRecord(part)) {
      return false;
    }
    if (part['type'] === 'text' || part['type'] === 'reasoning') {
      return typeof part['text'] === 'string';
    }
    if (part['type'] === 'tool-call') {
      return (
        typeof part['toolCallId'] === 'string' &&
        typeof part['toolName'] === 'string' &&
        typeof part['argsText'] === 'string' &&
        Object.hasOwn(part, 'args')
      );
    }
    return (
      part['type'] === 'data' && typeof part['name'] === 'string' && Object.hasOwn(part, 'data')
    );
  });
}

export function isAssistantActiveRunDiscoveryResponse(
  value: unknown
): value is AssistantActiveRunDiscoveryResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (!Object.hasOwn(value, 'activeRun')) {
    return false;
  }
  if (value['activeRun'] === null) {
    return (
      (Object.keys(value).length === 1 && !Object.hasOwn(value, 'initializing')) ||
      (Object.keys(value).length === 2 && value['initializing'] === true)
    );
  }
  return Object.keys(value).length === 1 && isDiscoveredRun(value['activeRun']);
}
