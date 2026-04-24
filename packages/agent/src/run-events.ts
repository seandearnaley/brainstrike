export const ASSISTANT_RUN_EVENT_DATA_NAME = 'brainstrike.run-event';

export type AssistantRunEventKind =
  | 'context.budget'
  | 'context.prepared'
  | 'context.selection'
  | 'memory.configured'
  | 'memory.history.loaded'
  | 'memory.observation.completed'
  | 'memory.observation.started'
  | 'memory.reflection.completed'
  | 'memory.reflection.started'
  | 'memory.semantic.completed'
  | 'memory.semantic.started'
  | 'memory.working.loaded'
  | 'memory.working.updated'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.finished'
  | 'run.started'
  | 'run.step.finished'
  | 'run.step.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.started';

export type AssistantRunEventStatus = 'cancelled' | 'completed' | 'failed' | 'info' | 'running';

export type AssistantRunEventJson =
  | AssistantRunEventJson[]
  | boolean
  | null
  | number
  | string
  | { [key: string]: AssistantRunEventJson };

export type AssistantRunEventMetadata = Record<string, AssistantRunEventJson>;

export interface AssistantRunEvent {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly id: string;
  readonly kind: AssistantRunEventKind;
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly runId?: string;
  readonly sequence?: number;
  readonly status: AssistantRunEventStatus;
  readonly timestamp: string;
}

export type AssistantRunEventSink = (event: AssistantRunEvent) => Promise<void> | void;

const UNSAFE_RUN_EVENT_METADATA_KEYS = new Set([
  'apikey',
  'authorization',
  'content',
  'cookie',
  'memory',
  'output',
  'password',
  'prompt',
  'reasoning',
  'result',
  'secret',
  'text',
  'token',
]);

export function createAssistantRunEvent(input: {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly kind: AssistantRunEventKind;
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly runId?: string;
  readonly sequence?: number;
  readonly status: AssistantRunEventStatus;
}): AssistantRunEvent {
  return {
    id: `run-event-${crypto.randomUUID()}`,
    kind: input.kind,
    label: input.label,
    status: input.status,
    timestamp: new Date().toISOString(),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

export function sanitizeAssistantRunEventMetadata(
  metadata: AssistantRunEventMetadata | Record<string, unknown> | undefined
): AssistantRunEventMetadata | undefined {
  if (!metadata) {
    return;
  }

  const sanitized = sanitizeRunEventJsonValue(metadata);
  return isPlainRecord(sanitized) ? sanitized : undefined;
}

function sanitizeRunEventJsonValue(value: unknown): AssistantRunEventJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRunEventJsonValue(item));
  }
  if (!isPlainRecord(value)) {
    return null;
  }

  const sanitized: Record<string, AssistantRunEventJson> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeRunEventMetadataKey(key);
    if (UNSAFE_RUN_EVENT_METADATA_KEYS.has(normalizedKey)) {
      continue;
    }
    sanitized[key] = sanitizeRunEventJsonValue(nested);
  }
  return sanitized;
}

function normalizeRunEventMetadataKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isPlainRecord(value: unknown): value is Record<string, AssistantRunEventJson> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
