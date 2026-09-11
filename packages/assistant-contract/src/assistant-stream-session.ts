export const ASSISTANT_STREAM_EVENT_ID_HEADER = 'X-Brainstrike-Assistant-Event-Id';
export const ASSISTANT_STREAM_MESSAGE_ID_HEADER = 'X-Brainstrike-Assistant-Message-Id';
export const ASSISTANT_STREAM_RESUME_PATH = '/assistant/resume';
export const ASSISTANT_RUN_STATUS_PATH = '/assistant/run-status';

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
  readonly runId: string;
}

export function isAssistantActiveRunSession(value: unknown): value is AssistantActiveRunSession {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record['assistantMessageId'] === 'string' &&
    record['assistantMessageId'].trim().length > 0 &&
    typeof record['eventId'] === 'string' &&
    record['eventId'].trim().length > 0 &&
    typeof record['runId'] === 'string' &&
    record['runId'].trim().length > 0
  );
}
