import {
  MASTRA_MEMORY_SCHEMA_SQL,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  ASSISTANT_RUN_EVENT_KINDS,
  ASSISTANT_RUN_EVENT_STATUSES,
  type AssistantRunEvent,
  type AssistantRunEventKind,
  type AssistantRunEventStatus,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import type { DbHandle } from '@brainstrike/db';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/ui/assistant-ui-panel';

export interface AssistantMemoryThread {
  readonly createdAt: Date;
  readonly id: string;
  readonly latestRun?: AssistantThreadRunRecord;
  readonly metadata?: AssistantThreadMetadata;
  readonly resourceId: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface AssistantThreadMetadata {
  readonly model?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly source?: string;
}

export type AssistantThreadRunStatus = 'cancelled' | 'completed' | 'failed' | 'running';
export type AssistantThreadRuntimeKind = 'browser' | 'gateway' | 'hosted' | 'local';

export interface AssistantThreadRunRecord {
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly error: string | null;
  readonly id: string;
  readonly model: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly resourceId: string;
  readonly runtimeKind: AssistantThreadRuntimeKind;
  readonly startedAt: Date;
  readonly status: AssistantThreadRunStatus;
  readonly threadId: string;
  readonly updatedAt: Date;
}

export interface CreateAssistantThreadRunInput {
  readonly completedAt?: Date | null;
  readonly error?: string | null;
  readonly id: string;
  readonly model: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly resourceId: string;
  readonly runtimeKind: AssistantThreadRuntimeKind;
  readonly startedAt?: Date;
  readonly status?: AssistantThreadRunStatus;
  readonly threadId: string;
}

export interface CompleteAssistantThreadRunInput {
  readonly error?: string | null;
  readonly status: Exclude<AssistantThreadRunStatus, 'running'>;
}

export interface AssistantThreadRepository {
  appendThreadRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
  completeThreadRun: (runId: string, input: CompleteAssistantThreadRunInput) => Promise<void>;
  createThread: (resourceId: string) => Promise<AssistantMemoryThread>;
  createThreadRun: (input: CreateAssistantThreadRunInput) => Promise<AssistantThreadRunRecord>;
  deleteThread: (threadId: string) => Promise<void>;
  listLatestThreadRuns: (resourceId: string) => Promise<readonly AssistantThreadRunRecord[]>;
  listMessages: (
    threadId: string,
    resourceId: string,
    options?: AssistantThreadMessageListOptions
  ) => Promise<readonly AssistantHistoryMessage[]>;
  listThreadRunEvents: (
    threadId: string,
    resourceId: string
  ) => Promise<readonly AssistantRunEvent[]>;
  listThreads: (resourceId: string) => Promise<readonly AssistantMemoryThread[]>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  updateThreadMetadata: (threadId: string, metadata: AssistantThreadMetadata) => Promise<void>;
}

interface AssistantHistoryMessage {
  readonly content: unknown;
  readonly createdAt: Date;
  readonly id: string;
  readonly role: string;
}

export interface AssistantThreadMessageListOptions {
  readonly limitLatest?: number;
}

export const ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT = 80;

const ASSISTANT_THREAD_RUNS_TABLE = 'brainstrike_assistant_thread_runs';
const ASSISTANT_RUN_EVENTS_TABLE = 'brainstrike_assistant_run_events';
const ASSISTANT_THREAD_RUNS_SCHEMA_SQL = `
${MASTRA_MEMORY_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS ${ASSISTANT_THREAD_RUNS_TABLE} (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  model_settings jsonb,
  provider_options jsonb,
  runtime_kind text NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_resource_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (resource_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_thread_latest_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (resource_id, thread_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_status_idx
  ON ${ASSISTANT_THREAD_RUNS_TABLE} (status);

CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_EVENTS_TABLE} (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES ${ASSISTANT_THREAD_RUNS_TABLE}(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES ${MASTRA_MEMORY_TABLES.threads}(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  label text NOT NULL,
  detail text,
  duration_ms integer,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_thread_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (thread_id, resource_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_run_idx
  ON ${ASSISTANT_RUN_EVENTS_TABLE} (run_id, sequence ASC, occurred_at ASC);
`;

const assistantThreadRepositoryCache = new WeakMap<DbHandle, AssistantThreadRepository>();
const assistantThreadSchemaInitPromises = new WeakMap<DbHandle, Promise<void>>();

function assertMemoryDatabase(database: DbHandle): asserts database is DbHandle & {
  exec: NonNullable<DbHandle['exec']>;
} {
  if (typeof database.exec !== 'function') {
    throw new Error('Assistant memory requires a database handle with exec support.');
  }
}

function createThreadId(): string {
  return `thread-${crypto.randomUUID()}`;
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid timestamp value');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new Error(`Invalid timestamp value: ${String(value)}`);
}

function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeDate(value);
}

function toMemoryThread(thread: {
  createdAt: unknown;
  id: string;
  latestRun?: AssistantThreadRunRecord;
  metadata?: unknown;
  resourceId: string;
  title?: string | null;
  updatedAt: unknown;
}): AssistantMemoryThread {
  return {
    id: thread.id,
    resourceId: thread.resourceId,
    title: thread.title?.trim() || 'New Thread',
    createdAt: normalizeDate(thread.createdAt),
    updatedAt: normalizeDate(thread.updatedAt),
    ...(thread.latestRun ? { latestRun: thread.latestRun } : {}),
    ...(isThreadMetadata(thread.metadata) ? { metadata: thread.metadata } : {}),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Mastra memory row: ${fieldName} is not a string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function optionalJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return optionalRecord(parsed);
}

function isThreadMetadata(value: unknown): value is AssistantThreadMetadata {
  if (!isRecord(value)) {
    return false;
  }
  return Boolean(
    optionalString(value['provider']) ||
      optionalString(value['model']) ||
      optionalRecord(value['modelSettings']) ||
      optionalRecord(value['providerOptions']) ||
      optionalString(value['source'])
  );
}

function requireRunStatus(value: unknown): AssistantThreadRunStatus {
  if (value === 'cancelled' || value === 'completed' || value === 'failed' || value === 'running') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: status is not valid.');
}

function requireRuntimeKind(value: unknown): AssistantThreadRuntimeKind {
  if (value === 'browser' || value === 'gateway' || value === 'hosted' || value === 'local') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: runtime_kind is not valid.');
}

function getRowValue(row: Record<string, unknown>, camelKey: string, snakeKey: string): unknown {
  return row[camelKey] ?? row[snakeKey];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const ASSISTANT_RUN_EVENT_KIND_SET = new Set<AssistantRunEventKind>(ASSISTANT_RUN_EVENT_KINDS);

const ASSISTANT_RUN_EVENT_STATUS_SET = new Set<AssistantRunEventStatus>(
  ASSISTANT_RUN_EVENT_STATUSES
);

function requireRunEventKind(value: unknown): AssistantRunEventKind {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_KIND_SET.has(value as AssistantRunEventKind)
  ) {
    return value as AssistantRunEventKind;
  }
  throw new Error('Invalid assistant run event row: kind is not valid.');
}

function requireRunEventStatus(value: unknown): AssistantRunEventStatus {
  if (
    typeof value === 'string' &&
    ASSISTANT_RUN_EVENT_STATUS_SET.has(value as AssistantRunEventStatus)
  ) {
    return value as AssistantRunEventStatus;
  }
  throw new Error('Invalid assistant run event row: status is not valid.');
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function toThreadRunEvent(row: Record<string, unknown>): AssistantRunEvent {
  const metadata = optionalJsonRecord(row['metadata']);
  const sanitizedMetadata = sanitizeAssistantRunEventMetadata(metadata);
  const detail = nullableString(row['detail']);
  const durationRaw = getRowValue(row, 'durationMs', 'duration_ms');
  const durationMs = isFiniteInteger(durationRaw) ? durationRaw : undefined;
  const event: AssistantRunEvent = {
    id: requireString(row['id'], 'id'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    kind: requireRunEventKind(row['kind']),
    status: requireRunEventStatus(row['status']),
    label: requireString(row['label'], 'label'),
    sequence: isFiniteInteger(row['sequence']) ? row['sequence'] : Number(row['sequence']),
    timestamp: normalizeDate(getRowValue(row, 'timestamp', 'occurred_at')).toISOString(),
    ...(detail ? { detail } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
  };
  if (!Number.isSafeInteger(event.sequence)) {
    throw new Error('Invalid assistant run event row: sequence is not valid.');
  }
  return event;
}

function toThreadRunRecord(row: Record<string, unknown>): AssistantThreadRunRecord {
  const modelSettings = optionalJsonRecord(getRowValue(row, 'modelSettings', 'model_settings'));
  const providerOptions = optionalJsonRecord(
    getRowValue(row, 'providerOptions', 'provider_options')
  );

  return {
    id: requireString(row['id'], 'id'),
    resourceId: requireString(getRowValue(row, 'resourceId', 'resource_id'), 'resourceId'),
    threadId: requireString(getRowValue(row, 'threadId', 'thread_id'), 'threadId'),
    provider: requireString(row['provider'], 'provider'),
    model: requireString(row['model'], 'model'),
    runtimeKind: requireRuntimeKind(getRowValue(row, 'runtimeKind', 'runtime_kind')),
    status: requireRunStatus(row['status']),
    error: nullableString(row['error']),
    startedAt: normalizeDate(getRowValue(row, 'startedAt', 'started_at')),
    completedAt: normalizeNullableDate(getRowValue(row, 'completedAt', 'completed_at')),
    createdAt: normalizeDate(getRowValue(row, 'createdAt', 'created_at')),
    updatedAt: normalizeDate(getRowValue(row, 'updatedAt', 'updated_at')),
    ...(modelSettings ? { modelSettings } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function toRunEventDataParts(runEvents: readonly AssistantRunEvent[]): Array<{
  readonly data: AssistantRunEvent;
  readonly name: typeof ASSISTANT_RUN_EVENT_DATA_NAME;
  readonly type: 'data';
}> {
  return runEvents.map((event) => ({
    type: 'data' as const,
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    data: event,
  }));
}

type AssistantHistoryLoadResult = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
type AssistantHistoryMessagePart =
  AssistantHistoryLoadResult['messages'][number]['message']['content'][number];
type AssistantHistoryTextPart = Extract<AssistantHistoryMessagePart, { type: 'text' }>;
type AssistantHistoryToolCallPart = Extract<AssistantHistoryMessagePart, { type: 'tool-call' }>;
type AssistantHydratedContentPart = AssistantHistoryTextPart | AssistantHistoryToolCallPart;
type AssistantHistoryRepositoryMessages = AssistantHistoryLoadResult['messages'];
interface AssistantToolResultSnapshot {
  readonly isError?: boolean;
  readonly result?: unknown;
}

function extractText(value: unknown, seenObjects = new WeakSet<object>()): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (seenObjects.has(value)) {
    return '';
  }
  seenObjects.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item, seenObjects))
      .filter(Boolean)
      .join('\n');
  }

  const record = value as Record<string, unknown>;
  const directText = record['text'];
  if (typeof directText === 'string') {
    return directText;
  }
  const content = record['content'];
  if (typeof content === 'string') {
    return content;
  }
  return extractText(content, seenObjects);
}

function readContentPartArray(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const parts = record['parts'];
  if (Array.isArray(parts)) {
    return parts;
  }
  const content = record['content'];
  return Array.isArray(content) ? content : undefined;
}

function stringifyArgsText(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

function toHistoryToolCallPart(
  record: Record<string, unknown>,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHistoryToolCallPart | undefined {
  const toolCallId = record['toolCallId'];
  const toolName = record['toolName'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return;
  }
  const args = (
    record['args'] && typeof record['args'] === 'object' && !Array.isArray(record['args'])
      ? record['args']
      : {}
  ) as AssistantHistoryToolCallPart['args'];
  const argsText =
    typeof record['argsText'] === 'string' ? record['argsText'] : stringifyArgsText(args);
  const persistedResult = toolResultsByCallId.get(toolCallId);
  const hasInlineResult = Object.hasOwn(record, 'result');
  const isError =
    typeof record['isError'] === 'boolean' ? record['isError'] : persistedResult?.isError;
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
    argsText,
    ...(hasInlineResult ? { result: record['result'] } : {}),
    ...(hasInlineResult || !persistedResult || !Object.hasOwn(persistedResult, 'result')
      ? {}
      : { result: persistedResult.result }),
    ...(isError === undefined ? {} : { isError }),
  };
}

function toTextHistoryContentParts(value: unknown): AssistantHistoryTextPart[] {
  const text = extractText(value).trim();
  return text ? [{ type: 'text', text }] : [];
}

function toAssistantHistoryContentParts(
  value: unknown,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHydratedContentPart[] {
  const rawParts = readContentPartArray(value);
  if (!rawParts) {
    return toTextHistoryContentParts(value);
  }

  const parts: AssistantHydratedContentPart[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      continue;
    }
    const record = rawPart as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      const text = record['text'].trim();
      if (text) {
        parts.push({ type: 'text', text });
      }
      continue;
    }
    if (record['type'] === 'tool-call') {
      const toolPart = toHistoryToolCallPart(record, toolResultsByCallId);
      if (toolPart) {
        parts.push(toolPart);
      }
    }
  }
  return parts;
}

function toToolResultSnapshot(record: Record<string, unknown>): {
  readonly snapshot: AssistantToolResultSnapshot;
  readonly toolCallId: string;
} | null {
  const toolCallId = record['toolCallId'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return null;
  }
  const hasResult = Object.hasOwn(record, 'result');
  const hasOutput = Object.hasOwn(record, 'output');
  const hasError = Object.hasOwn(record, 'error');
  if (!(hasResult || hasOutput || hasError || typeof record['isError'] === 'boolean')) {
    return null;
  }
  return {
    toolCallId,
    snapshot: {
      ...(hasResult
        ? { result: record['result'] }
        : hasOutput
          ? { result: record['output'] }
          : hasError
            ? { result: record['error'] }
            : {}),
      ...(typeof record['isError'] === 'boolean'
        ? { isError: record['isError'] }
        : hasError
          ? { isError: true }
          : {}),
    },
  };
}

function readToolResultParts(value: unknown): readonly unknown[] {
  const rawParts = readContentPartArray(value);
  if (rawParts) {
    return rawParts;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
}

function collectToolResults(
  messages: readonly AssistantHistoryMessage[]
): ReadonlyMap<string, AssistantToolResultSnapshot> {
  const results = new Map<string, AssistantToolResultSnapshot>();
  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const rawPart of readToolResultParts(message.content)) {
      if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
        continue;
      }
      const record = rawPart as Record<string, unknown>;
      if (record['type'] !== undefined && record['type'] !== 'tool-result') {
        continue;
      }
      const toolResult = toToolResultSnapshot(record);
      if (toolResult) {
        results.set(toolResult.toolCallId, toolResult.snapshot);
      }
    }
  }
  return results;
}

function appendAssistantHistoryMessage(args: {
  latestAssistantMessageId: string | null;
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
  runEventDataParts: ReturnType<typeof toRunEventDataParts>;
  runEvents: readonly AssistantRunEvent[];
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>;
}): boolean {
  const content = toAssistantHistoryContentParts(args.message.content, args.toolResultsByCallId);
  if (content.length === 0) {
    return false;
  }

  const isLatestAssistantMessage =
    args.runEvents.length > 0 && args.message.id === args.latestAssistantMessageId;
  args.repositoryMessages.push({
    parentId: args.parentId,
    message: {
      id: args.message.id,
      role: 'assistant',
      content: isLatestAssistantMessage ? [...args.runEventDataParts, ...content] : content,
      createdAt: args.message.createdAt,
      status: { type: 'complete', reason: 'stop' },
      metadata: {
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_state: null,
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_annotations: [],
        // biome-ignore lint/style/useNamingConvention: assistant-ui requires this metadata key.
        unstable_data: [],
        steps: [],
        custom: {},
      },
    },
  });
  return true;
}

function appendUserHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const content = toTextHistoryContentParts(args.message.content);
  if (content.length === 0) {
    return false;
  }

  args.repositoryMessages.push({
    parentId: args.parentId,
    message: {
      id: args.message.id,
      role: 'user',
      content,
      createdAt: args.message.createdAt,
      attachments: [],
      metadata: { custom: {} },
    },
  });
  return true;
}

function appendSystemHistoryMessage(args: {
  message: AssistantHistoryMessage;
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): boolean {
  const textPart = toTextHistoryContentParts(args.message.content).at(0);
  if (!textPart) {
    return false;
  }

  args.repositoryMessages.push({
    parentId: args.parentId,
    message: {
      id: args.message.id,
      role: 'system',
      content: [textPart],
      createdAt: args.message.createdAt,
      metadata: { custom: {} },
    },
  });
  return true;
}

function toHistoryRepository(
  messages: readonly AssistantHistoryMessage[],
  runEvents: readonly AssistantRunEvent[] = []
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const repositoryMessages: Awaited<
    ReturnType<AssistantUiThreadHistoryAdapter['load']>
  >['messages'] = [];
  let parentId: string | null = null;
  let latestAssistantMessageId: string | null = null;
  const runEventDataParts = toRunEventDataParts(runEvents);
  const toolResultsByCallId = collectToolResults(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate?.role === 'assistant' &&
      toAssistantHistoryContentParts(candidate.content, toolResultsByCallId).length > 0
    ) {
      latestAssistantMessageId = candidate.id;
      break;
    }
  }

  for (const message of messages) {
    if (!(message.role === 'user' || message.role === 'assistant' || message.role === 'system')) {
      continue;
    }

    let appended = false;
    if (message.role === 'assistant') {
      // This compatibility view attaches persisted run summaries to the latest
      // assistant message until run records carry a durable message id.
      appended = appendAssistantHistoryMessage({
        latestAssistantMessageId,
        message,
        parentId,
        repositoryMessages,
        runEventDataParts,
        runEvents,
        toolResultsByCallId,
      });
    } else if (message.role === 'user') {
      appended = appendUserHistoryMessage({
        message,
        parentId,
        repositoryMessages,
      });
    } else {
      appended = appendSystemHistoryMessage({
        message,
        parentId,
        repositoryMessages,
      });
    }
    if (appended) {
      parentId = message.id;
    }
  }

  return {
    headId: repositoryMessages.at(-1)?.message.id ?? null,
    messages: repositoryMessages,
  };
}

export function createPgliteAssistantThreadRepository(
  database: DbHandle
): AssistantThreadRepository {
  assertMemoryDatabase(database);
  const cachedRepository = assistantThreadRepositoryCache.get(database);
  if (cachedRepository) {
    return cachedRepository;
  }
  const initialize = async (): Promise<void> => {
    let initPromise = assistantThreadSchemaInitPromises.get(database);
    if (!initPromise) {
      initPromise = database
        .exec(ASSISTANT_THREAD_RUNS_SCHEMA_SQL)
        .then(() => undefined)
        .catch((error: unknown) => {
          assistantThreadSchemaInitPromises.delete(database);
          throw error;
        });
      assistantThreadSchemaInitPromises.set(database, initPromise);
    }
    await initPromise;
  };

  const listLatestThreadRuns = async (
    resourceId: string
  ): Promise<readonly AssistantThreadRunRecord[]> => {
    await initialize();
    const result = await database.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (thread_id)
          id,
          resource_id AS "resourceId",
          thread_id AS "threadId",
          provider,
          model,
          model_settings AS "modelSettings",
          provider_options AS "providerOptions",
          runtime_kind AS "runtimeKind",
          status,
          error,
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
       FROM ${ASSISTANT_THREAD_RUNS_TABLE}
       WHERE resource_id = $1
       ORDER BY thread_id, started_at DESC, id DESC`,
      [resourceId]
    );
    return result.rows.map(toThreadRunRecord);
  };

  const listThreadRunEvents = async (
    threadId: string,
    resourceId: string
  ): Promise<readonly AssistantRunEvent[]> => {
    await initialize();
    const result = await database.query<Record<string, unknown>>(
      `SELECT
          id,
          run_id,
          sequence,
          kind,
          status,
          label,
          detail,
          duration_ms,
          metadata,
          occurred_at
       FROM ${ASSISTANT_RUN_EVENTS_TABLE}
       WHERE thread_id = $1
          AND resource_id = $2
          AND run_id = (
            SELECT id
            FROM ${ASSISTANT_THREAD_RUNS_TABLE}
            WHERE thread_id = $1 AND resource_id = $2
            ORDER BY started_at DESC, created_at DESC, id DESC
            LIMIT 1
          )
       ORDER BY sequence ASC, occurred_at ASC, id ASC`,
      [threadId, resourceId]
    );
    return result.rows.map(toThreadRunEvent);
  };

  const repository: AssistantThreadRepository = {
    async appendThreadRunEvent(runId: string, event: AssistantRunEvent): Promise<void> {
      await initialize();
      const sequence = event.sequence ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Assistant run event sequence must be a non-negative safe integer.');
      }
      const occurredAt = normalizeDate(event.timestamp);
      const sanitizedMetadata = sanitizeAssistantRunEventMetadata(event.metadata);
      const now = new Date();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_EVENTS_TABLE}
          (
            id,
            run_id,
            resource_id,
            thread_id,
            sequence,
            kind,
            status,
            label,
            detail,
            metadata,
            duration_ms,
            occurred_at,
            created_at,
            updated_at
          )
         SELECT
            $1,
            runs.id,
            runs.resource_id,
            runs.thread_id,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::jsonb,
            $9,
            $10,
            $11,
            $12
         FROM ${ASSISTANT_THREAD_RUNS_TABLE} AS runs
         WHERE runs.id = $2
         ON CONFLICT (id) DO UPDATE SET
            sequence = EXCLUDED.sequence,
            kind = EXCLUDED.kind,
            status = EXCLUDED.status,
            label = EXCLUDED.label,
            detail = EXCLUDED.detail,
            metadata = EXCLUDED.metadata,
            duration_ms = EXCLUDED.duration_ms,
            occurred_at = EXCLUDED.occurred_at,
            updated_at = EXCLUDED.updated_at`,
        [
          event.id,
          runId,
          sequence,
          event.kind,
          event.status,
          event.label,
          event.detail ?? null,
          sanitizedMetadata ? JSON.stringify(sanitizedMetadata) : null,
          event.durationMs ?? null,
          occurredAt,
          now,
          now,
        ]
      );
    },
    async completeThreadRun(runId: string, input: CompleteAssistantThreadRunInput): Promise<void> {
      await initialize();
      await database.query(
        `UPDATE ${ASSISTANT_THREAD_RUNS_TABLE}
         SET status = $2, error = $3, completed_at = $4, updated_at = $5
         WHERE id = $1`,
        [runId, input.status, input.error ?? null, new Date(), new Date()]
      );
    },
    async createThread(resourceId: string): Promise<AssistantMemoryThread> {
      await initialize();
      const now = new Date();
      const thread = {
        id: createThreadId(),
        resourceId,
        title: 'New Thread',
        createdAt: now,
        updatedAt: now,
      } satisfies AssistantMemoryThread;
      await database.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
          (id, "resourceId", title, metadata, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          thread.id,
          thread.resourceId,
          thread.title,
          JSON.stringify({ source: 'brainstrike' }),
          thread.createdAt,
          thread.updatedAt,
        ]
      );
      return thread;
    },
    async createThreadRun(input: CreateAssistantThreadRunInput): Promise<AssistantThreadRunRecord> {
      await initialize();
      const now = new Date();
      const startedAt = input.startedAt ?? now;
      const completedAt = input.completedAt ?? null;
      const record = {
        id: input.id,
        resourceId: input.resourceId,
        threadId: input.threadId,
        provider: input.provider,
        model: input.model,
        runtimeKind: input.runtimeKind,
        status: input.status ?? 'running',
        error: input.error ?? null,
        startedAt,
        completedAt,
        createdAt: now,
        updatedAt: now,
        ...(input.modelSettings ? { modelSettings: { ...input.modelSettings } } : {}),
        ...(input.providerOptions ? { providerOptions: { ...input.providerOptions } } : {}),
      } satisfies AssistantThreadRunRecord;
      await database.query(
        `INSERT INTO ${ASSISTANT_THREAD_RUNS_TABLE}
          (
            id,
            resource_id,
            thread_id,
            provider,
            model,
            model_settings,
            provider_options,
            runtime_kind,
            status,
            error,
            started_at,
            completed_at,
            created_at,
            updated_at
          )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)`,
        [
          record.id,
          record.resourceId,
          record.threadId,
          record.provider,
          record.model,
          record.modelSettings ? JSON.stringify(record.modelSettings) : null,
          record.providerOptions ? JSON.stringify(record.providerOptions) : null,
          record.runtimeKind,
          record.status,
          record.error,
          record.startedAt,
          record.completedAt,
          record.createdAt,
          record.updatedAt,
        ]
      );
      return record;
    },
    async deleteThread(threadId: string): Promise<void> {
      await initialize();
      await database.query(
        `WITH deleted_observational_memory AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
            WHERE "threadId" = $1 OR "lookupKey" = $2
            RETURNING id
          ),
          deleted_messages AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.messages}
            WHERE thread_id = $1
            RETURNING id
          ),
          deleted_thread AS (
            DELETE FROM ${MASTRA_MEMORY_TABLES.threads}
            WHERE id = $1
            RETURNING id
          )
         SELECT
          (SELECT count(*) FROM deleted_observational_memory) AS deleted_observational_memory_count,
          (SELECT count(*) FROM deleted_messages) AS deleted_message_count,
          (SELECT count(*) FROM deleted_thread) AS deleted_thread_count`,
        [threadId, `thread:${threadId}`]
      );
    },
    listThreadRunEvents,
    async listMessages(
      threadId: string,
      resourceId: string,
      options?: AssistantThreadMessageListOptions
    ): Promise<readonly AssistantHistoryMessage[]> {
      await initialize();
      const limitLatest =
        typeof options?.limitLatest === 'number' && Number.isSafeInteger(options.limitLatest)
          ? options.limitLatest
          : undefined;
      if (limitLatest !== undefined && limitLatest < 1) {
        throw new Error('Assistant message history limit must be a positive safe integer.');
      }
      const params: unknown[] = [threadId, resourceId];
      const sql =
        limitLatest === undefined
          ? `SELECT id, role, content, "createdAt"
             FROM ${MASTRA_MEMORY_TABLES.messages}
             WHERE thread_id = $1 AND "resourceId" = $2
             ORDER BY "createdAt" ASC, id ASC`
          : `SELECT id, role, content, "createdAt"
             FROM (
               SELECT id, role, content, "createdAt"
               FROM ${MASTRA_MEMORY_TABLES.messages}
               WHERE thread_id = $1 AND "resourceId" = $2
               -- id is a deterministic tie-breaker for same-timestamp rows;
               -- insertion-order ties need a future monotonic schema column.
               ORDER BY "createdAt" DESC, id DESC
               LIMIT $3
             ) AS recent_messages
             ORDER BY "createdAt" ASC, id ASC`;
      if (limitLatest !== undefined) {
        params.push(limitLatest);
      }
      const result = await database.query<Record<string, unknown>>(sql, params);
      return result.rows.map((row) => ({
        id: requireString(row['id'], 'id'),
        role: requireString(row['role'], 'role'),
        content: parseJson(row['content']),
        createdAt: normalizeDate(row['createdAt']),
      }));
    },
    listLatestThreadRuns,
    async listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
         FROM ${MASTRA_MEMORY_TABLES.threads}
         WHERE "resourceId" = $1
         ORDER BY "updatedAt" DESC, id DESC`,
        [resourceId]
      );
      const latestRunByThreadId = new Map(
        (await listLatestThreadRuns(resourceId)).map((run) => [run.threadId, run])
      );
      return result.rows.map((row) => {
        const threadId = requireString(row['id'], 'id');
        const latestRun = latestRunByThreadId.get(threadId);
        return toMemoryThread({
          id: threadId,
          resourceId: requireString(row['resourceId'], 'resourceId'),
          title: typeof row['title'] === 'string' ? row['title'] : null,
          metadata: parseJson(row['metadata']),
          createdAt: row['createdAt'],
          updatedAt: row['updatedAt'],
          ...(latestRun ? { latestRun } : {}),
        });
      });
    },
    async renameThread(threadId: string, title: string): Promise<void> {
      const normalizedTitle = title.trim();
      if (!normalizedTitle) {
        throw new Error('Thread title is required.');
      }
      await initialize();
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET title = $2, "updatedAt" = $3
         WHERE id = $1`,
        [threadId, normalizedTitle, new Date()]
      );
    },
    async updateThreadMetadata(threadId: string, metadata: AssistantThreadMetadata): Promise<void> {
      await initialize();
      await database.query(
        `UPDATE ${MASTRA_MEMORY_TABLES.threads}
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, "updatedAt" = $3
         WHERE id = $1`,
        [threadId, JSON.stringify(metadata), new Date()]
      );
    },
  };
  assistantThreadRepositoryCache.set(database, repository);
  return repository;
}

export function createAssistantThreadHistoryAdapter({
  repository,
  resourceId,
  threadId,
}: {
  readonly repository: AssistantThreadRepository;
  readonly resourceId: string;
  readonly threadId: string;
}): AssistantUiThreadHistoryAdapter {
  return {
    async load() {
      const messages = await repository.listMessages(threadId, resourceId, {
        limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
      });
      const runEvents = await repository.listThreadRunEvents(threadId, resourceId);
      return toHistoryRepository(messages, runEvents);
    },
    async append() {
      // Mastra is the durable writer for assistant conversations. The client adapter is read-through
      // only to avoid duplicate message rows with client-generated IDs.
    },
  };
}
