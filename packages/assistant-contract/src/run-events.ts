export const ASSISTANT_RUN_EVENT_DATA_NAME = 'brainstrike.run-event';

export const ASSISTANT_RUN_EVENT_KINDS = [
  'context.budget',
  'context.prepared',
  'context.selection',
  'hook.blocked',
  'hook.notice',
  'memory.configured',
  'memory.history.loaded',
  'memory.observation.completed',
  // A background observation/buffering cycle FAILED (streamed by Mastra as a
  // `data-om-*-failed` chunk). Deliberately its own kind: this was the only
  // runtime evidence of the BST-940 field failure (a broken observer failing
  // every cycle) and must stay visible in the run timeline, never dropped as
  // an unrecognized chunk.
  'memory.observation.failed',
  'memory.observation.started',
  'memory.reflection.completed',
  'memory.reflection.started',
  'memory.semantic.completed',
  'memory.semantic.started',
  'memory.working.loaded',
  'memory.working.updated',
  'run.cancelled',
  'run.failed',
  'run.finished',
  'run.started',
  'run.steered',
  'run.step.finished',
  'run.step.started',
  'subagent.failed',
  'subagent.finished',
  'subagent.started',
  'subagent.tool.completed',
  'subagent.tool.failed',
  'subagent.tool.started',
  'tool.completed',
  'tool.failed',
  // A suspending tool paused a run this build has no registered resume UI for
  // (BST-558). Deliberately NOT `tool.failed`: no tool ran and none failed, the
  // Mastra snapshot stays suspended, and a build that later registers the tool
  // resumes the SAME toolCallId and emits the real `tool.completed`. Reusing
  // `tool.failed` would invent a failed tool call in the Task Ledger AND
  // double-count that one call, and would close out `tool.started` in the
  // timeline / duration pairings while the tool is still suspended.
  'tool.resume.unsupported',
  'tool.started',
] as const;

export type AssistantRunEventKind = (typeof ASSISTANT_RUN_EVENT_KINDS)[number];

export const ASSISTANT_RUN_EVENT_STATUSES = [
  'cancelled',
  'completed',
  'failed',
  'info',
  'running',
] as const;

export type AssistantRunEventStatus = (typeof ASSISTANT_RUN_EVENT_STATUSES)[number];

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

export function emitAssistantRunEventSafely(input: {
  readonly event: {
    readonly detail?: string;
    readonly durationMs?: number;
    readonly kind: AssistantRunEventKind;
    readonly label: string;
    readonly metadata?: AssistantRunEventMetadata;
    readonly status: AssistantRunEventStatus;
  };
  readonly eventSink: AssistantRunEventSink | undefined;
  readonly onError: (error: unknown, event: AssistantRunEvent) => void;
  readonly runId: string | undefined;
}): void {
  if (!(input.eventSink && input.runId)) {
    return;
  }

  const event = createAssistantRunEvent({
    ...input.event,
    runId: input.runId,
  });
  try {
    void Promise.resolve(input.eventSink(event)).catch((error: unknown) => {
      input.onError(error, event);
    });
  } catch (error) {
    input.onError(error, event);
  }
}

const UNSAFE_RUN_EVENT_METADATA_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'content',
  'cookie',
  'credential',
  'memory',
  'output',
  'password',
  'prompt',
  'reasoning',
  'result',
  'secret',
  'session',
  'text',
  'token',
]);

const MAX_RUN_EVENT_METADATA_DEPTH = 8;

const UNSAFE_RUN_EVENT_METADATA_KEY_FRAGMENTS = [
  'apikey',
  'accesstoken',
  'authorization',
  'authtoken',
  'bearer',
  'cookie',
  'credential',
  'idtoken',
  'password',
  'refreshtoken',
  'secret',
  'session',
] as const;

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

  const sanitized = sanitizeRunEventJsonValue(metadata, 0);
  return isPlainRecord(sanitized) ? sanitized : undefined;
}

function sanitizeRunEventJsonValue(value: unknown, depth: number): AssistantRunEventJson {
  if (depth > MAX_RUN_EVENT_METADATA_DEPTH) {
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRunEventJsonValue(item, depth + 1));
  }
  if (!isPlainRecord(value)) {
    return null;
  }

  const sanitized: Record<string, AssistantRunEventJson> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeRunEventMetadataKey(key);
    if (isUnsafeRunEventMetadataKey(normalizedKey)) {
      continue;
    }
    sanitized[key] = sanitizeRunEventJsonValue(nested, depth + 1);
  }
  return sanitized;
}

function isUnsafeRunEventMetadataKey(normalizedKey: string): boolean {
  if (UNSAFE_RUN_EVENT_METADATA_KEYS.has(normalizedKey)) {
    return true;
  }
  return UNSAFE_RUN_EVENT_METADATA_KEY_FRAGMENTS.some((unsafeKey) =>
    normalizedKey.includes(unsafeKey)
  );
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

const ASSISTANT_RUN_EVENT_KIND_SET: ReadonlySet<string> = new Set(ASSISTANT_RUN_EVENT_KINDS);
const ASSISTANT_RUN_EVENT_STATUS_SET: ReadonlySet<string> = new Set(ASSISTANT_RUN_EVENT_STATUSES);

function isAssistantRunEventJson(value: unknown, depth: number): value is AssistantRunEventJson {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'number' || kind === 'string') {
    return true;
  }
  if (depth >= MAX_RUN_EVENT_METADATA_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isAssistantRunEventJson(entry, depth + 1));
  }
  if (kind === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isAssistantRunEventJson(entry, depth + 1)
    );
  }
  return false;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * INBOUND structural guard for run events crossing the wire (BST-978 slice 2).
 * The outbound side already sanitizes via `sanitizeAssistantRunEventMetadata`;
 * this is the receiving side's single narrow, replacing per-consumer partial
 * checks. Full shape: required fields present and typed, `kind`/`status`
 * members of the closed unions, metadata a bounded JSON record (same depth
 * cap as the sanitizer, arrays rejected at the top level).
 */
export function isAssistantRunEvent(value: unknown): value is AssistantRunEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    typeof record['label'] !== 'string' ||
    typeof record['timestamp'] !== 'string'
  ) {
    return false;
  }
  if (
    typeof record['kind'] !== 'string' ||
    !ASSISTANT_RUN_EVENT_KIND_SET.has(record['kind']) ||
    typeof record['status'] !== 'string' ||
    !ASSISTANT_RUN_EVENT_STATUS_SET.has(record['status'])
  ) {
    return false;
  }
  if (
    !(
      isOptionalString(record['detail']) &&
      isOptionalString(record['runId']) &&
      isOptionalFiniteNumber(record['durationMs']) &&
      isOptionalFiniteNumber(record['sequence'])
    )
  ) {
    return false;
  }
  const metadata = record['metadata'];
  if (metadata === undefined) {
    return true;
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return false;
  }
  return Object.values(metadata as Record<string, unknown>).every((entry) =>
    isAssistantRunEventJson(entry, 1)
  );
}

/**
 * Narrow an assistant-ui data part to its run event: a record named
 * `ASSISTANT_RUN_EVENT_DATA_NAME` whose `data` passes `isAssistantRunEvent`.
 * Returns undefined otherwise — consumers skip malformed parts, never throw
 * (a notification trigger must never crash the panel over a shape mismatch).
 */
export function readAssistantRunEventDataPart(part: unknown): AssistantRunEvent | undefined {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return;
  }
  const record = part as Record<string, unknown>;
  if (record['name'] !== ASSISTANT_RUN_EVENT_DATA_NAME) {
    return;
  }
  return isAssistantRunEvent(record['data']) ? record['data'] : undefined;
}
