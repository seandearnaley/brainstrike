export const ASSISTANT_STREAM_EVENT_ID_HEADER = 'X-Brainstrike-Assistant-Event-Id';
export const ASSISTANT_STREAM_RESUME_PATH = '/assistant/resume';

export interface AssistantActiveRunSession {
  readonly eventId: string;
  readonly runId: string;
}

export function isAssistantActiveRunSession(value: unknown): value is AssistantActiveRunSession {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record['eventId'] === 'string' &&
    record['eventId'].trim().length > 0 &&
    typeof record['runId'] === 'string' &&
    record['runId'].trim().length > 0
  );
}
