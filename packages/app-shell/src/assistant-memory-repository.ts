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

export const ASSISTANT_THREAD_ICON_IDS = [
  'message',
  'bug',
  'code',
  'rocket',
  'research',
  'plan',
] as const;

export const ASSISTANT_THREAD_COLOR_IDS = [
  'blue',
  'emerald',
  'amber',
  'rose',
  'violet',
  'slate',
] as const;

export type AssistantThreadIconId = (typeof ASSISTANT_THREAD_ICON_IDS)[number];
export type AssistantThreadColorId = (typeof ASSISTANT_THREAD_COLOR_IDS)[number];

export interface AssistantThreadMetadata {
  readonly color?: AssistantThreadColorId;
  readonly icon?: AssistantThreadIconId;
  readonly model?: string;
  readonly modelSettings?: Record<string, unknown>;
  readonly provider?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly source?: string;
}

type MutableAssistantThreadMetadata = {
  -readonly [Key in keyof AssistantThreadMetadata]?: AssistantThreadMetadata[Key];
};

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

/**
 * One durable token-usage record. model/provider are stored PER ROW because a
 * thread can switch models mid-conversation; cost must be computed per row
 * against that row's pricing and summed, never against the thread's current
 * model.
 */
export interface RecordRunUsageInput {
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  readonly resourceId: string;
  readonly runId: string;
  readonly threadId: string;
}

/** Per-model token subtotal for a single thread. */
export interface ThreadModelUsageSubtotal {
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
}

/**
 * Cumulative durable token usage for a thread. `perModel` carries the
 * per-(provider, model) subtotals so the UI can price each model with its own
 * registry rate and sum — the thread totals alone cannot be priced when the
 * thread mixed models.
 */
export interface ThreadCumulativeUsage {
  readonly perModel: readonly ThreadModelUsageSubtotal[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export interface AssistantThreadRepository {
  appendThreadRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
  completeThreadRun: (runId: string, input: CompleteAssistantThreadRunInput) => Promise<void>;
  createThread: (resourceId: string) => Promise<AssistantMemoryThread>;
  createThreadRun: (input: CreateAssistantThreadRunInput) => Promise<AssistantThreadRunRecord>;
  deleteThread: (threadId: string) => Promise<void>;
  getThreadCumulativeUsage: (threadId: string) => Promise<ThreadCumulativeUsage | null>;
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
  recordRunUsage: (input: RecordRunUsageInput) => Promise<void>;
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
const ASSISTANT_RUN_USAGE_TABLE = 'brainstrike_assistant_run_usage';
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

-- Durable per-thread token usage (Phase 5.1). model/provider are PER ROW so
-- cost is attributable per model when a thread switches models mid-run.
-- Bootstrapped here (alongside the runs table) AND created by migration 046 so
-- both the test-only numbered runner and the real app converge on one shape.
-- No FK to mastra_threads: usage may be recorded for non-memory-backed turns,
-- and the row is a billing fact that should outlive a thread deletion cascade.
CREATE TABLE IF NOT EXISTS ${ASSISTANT_RUN_USAGE_TABLE} (
  id text PRIMARY KEY,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  resource_id text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_usage_thread
  ON ${ASSISTANT_RUN_USAGE_TABLE} (thread_id);
`;

const assistantThreadRepositoryCache = new WeakMap<DbHandle, AssistantThreadRepository>();
const assistantThreadSchemaInitPromises = new WeakMap<DbHandle, Promise<void>>();
const ASSISTANT_THREAD_ICON_ID_SET = new Set<string>(ASSISTANT_THREAD_ICON_IDS);
const ASSISTANT_THREAD_COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);
const ASSISTANT_THREAD_METADATA_KEYS = new Set<string>([
  'color',
  'icon',
  'model',
  'modelSettings',
  'provider',
  'providerOptions',
  'source',
]);

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
  const metadata = sanitizeThreadMetadata(thread.metadata);
  return {
    id: thread.id,
    resourceId: thread.resourceId,
    title: thread.title?.trim() || 'New Thread',
    createdAt: normalizeDate(thread.createdAt),
    updatedAt: normalizeDate(thread.updatedAt),
    ...(thread.latestRun ? { latestRun: thread.latestRun } : {}),
    ...(metadata ? { metadata } : {}),
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

/**
 * Validate a usage token count before persistence. Malformed values THROW —
 * there is no silent coercion to 0 (see AGENTS.md "no silent fallbacks").
 */
function assertUsageTokenCount(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Assistant run usage ${fieldName} must be a non-negative safe integer.`);
  }
}

/**
 * Coerce a SUM() aggregate (PGlite returns ::bigint as a string) into a
 * non-negative integer, throwing if the DB hands back something unparseable.
 */
function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isFinite(parsed) && Number.isInteger(parsed)) || parsed < 0) {
    throw new Error(`Invalid run usage aggregate: ${fieldName} is not a non-negative integer.`);
  }
  return parsed;
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

function optionalThreadIconId(value: unknown): AssistantThreadIconId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_ICON_ID_SET.has(value)
    ? (value as AssistantThreadIconId)
    : undefined;
}

function optionalThreadColorId(value: unknown): AssistantThreadColorId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_COLOR_ID_SET.has(value)
    ? (value as AssistantThreadColorId)
    : undefined;
}

function sanitizeThreadMetadata(value: unknown): AssistantThreadMetadata | undefined {
  if (!isRecord(value)) {
    return;
  }
  const metadata: MutableAssistantThreadMetadata = {};
  const icon = optionalThreadIconId(value['icon']);
  const color = optionalThreadColorId(value['color']);
  const provider = optionalString(value['provider']);
  const model = optionalString(value['model']);
  const modelSettings = optionalRecord(value['modelSettings']);
  const providerOptions = optionalRecord(value['providerOptions']);
  const source = optionalString(value['source']);

  if (icon) {
    metadata.icon = icon;
  }
  if (color) {
    metadata.color = color;
  }
  if (provider) {
    metadata.provider = provider;
  }
  if (model) {
    metadata.model = model;
  }
  if (modelSettings) {
    metadata.modelSettings = modelSettings;
  }
  if (providerOptions) {
    metadata.providerOptions = providerOptions;
  }
  if (source) {
    metadata.source = source;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function assertPersistableThreadMetadata(metadata: AssistantThreadMetadata): void {
  const metadataValue: unknown = metadata;
  if (!isRecord(metadataValue)) {
    throw new Error('Assistant thread metadata must be an object.');
  }
  for (const key of Object.keys(metadataValue)) {
    if (!ASSISTANT_THREAD_METADATA_KEYS.has(key)) {
      throw new Error(`Invalid assistant thread metadata key: ${key}.`);
    }
  }
  if (metadata.icon !== undefined && !ASSISTANT_THREAD_ICON_ID_SET.has(metadata.icon)) {
    throw new Error('Invalid assistant thread metadata icon.');
  }
  if (metadata.color !== undefined && !ASSISTANT_THREAD_COLOR_ID_SET.has(metadata.color)) {
    throw new Error('Invalid assistant thread metadata color.');
  }
  if (metadata.provider !== undefined && !optionalString(metadata.provider)) {
    throw new Error('Invalid assistant thread metadata provider.');
  }
  if (metadata.model !== undefined && !optionalString(metadata.model)) {
    throw new Error('Invalid assistant thread metadata model.');
  }
  if (metadata.source !== undefined && !optionalString(metadata.source)) {
    throw new Error('Invalid assistant thread metadata source.');
  }
  if (metadata.modelSettings !== undefined && !optionalRecord(metadata.modelSettings)) {
    throw new Error('Invalid assistant thread metadata model settings.');
  }
  if (metadata.providerOptions !== undefined && !optionalRecord(metadata.providerOptions)) {
    throw new Error('Invalid assistant thread metadata provider options.');
  }
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
type AssistantHistoryReasoningPart = Extract<AssistantHistoryMessagePart, { type: 'reasoning' }>;
type AssistantHydratedContentPart =
  | AssistantHistoryTextPart
  | AssistantHistoryToolCallPart
  | AssistantHistoryReasoningPart;
type AssistantHistoryRepositoryMessages = AssistantHistoryLoadResult['messages'];
type AssistantRunEventDataPart = ReturnType<typeof toRunEventDataParts>[number];
interface AssistantToolResultSnapshot {
  readonly isError?: boolean;
  readonly result?: unknown;
}

/**
 * A hydrated content part paired with the epoch-ms moment it was produced
 * (Mastra persists per-part `createdAt` numbers). The timestamp drives
 * run-event interleaving so a reloaded thread reads in live order.
 */
interface TimedHistoryContentPart {
  readonly at?: number;
  readonly part: AssistantHydratedContentPart;
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

function toHistoryReasoningPart(
  record: Record<string, unknown>
): AssistantHistoryReasoningPart | undefined {
  const reasoningText =
    typeof record['text'] === 'string'
      ? record['text']
      : typeof record['reasoning'] === 'string'
        ? record['reasoning']
        : '';
  const trimmed = reasoningText.trim();
  return trimmed ? { type: 'reasoning', text: trimmed } : undefined;
}

/**
 * Mastra v2 (`MastraMessageContentV2`) persists tool calls as
 * `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
 * state, result } }` parts with the result INLINE — there are no separate
 * `role: 'tool'` rows in this dialect (see the live-loop proof in
 * packages/agent/src/__tests__/mastra-memory-persistence.spec.ts).
 */
function toHistoryToolCallPartFromInvocation(
  record: Record<string, unknown>
): AssistantHistoryToolCallPart | undefined {
  const invocation = record['toolInvocation'];
  if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation)) {
    return;
  }
  const inv = invocation as Record<string, unknown>;
  const state = typeof inv['state'] === 'string' ? inv['state'] : undefined;
  if (state === 'partial-call') {
    // Streaming-intermediate state; Mastra filters these before persisting,
    // so a stray one carries no renderable information.
    return;
  }
  const toolCallId = inv['toolCallId'];
  const toolName = inv['toolName'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return;
  }
  const args = (
    inv['args'] && typeof inv['args'] === 'object' && !Array.isArray(inv['args']) ? inv['args'] : {}
  ) as AssistantHistoryToolCallPart['args'];
  const hasResult = Object.hasOwn(inv, 'result');
  const errorText = typeof inv['errorText'] === 'string' ? inv['errorText'] : undefined;
  const isError = state === 'output-error' || inv['isError'] === true;
  return {
    type: 'tool-call',
    toolCallId,
    toolName,
    args,
    argsText: stringifyArgsText(args),
    ...(hasResult
      ? { result: inv['result'] }
      : errorText === undefined
        ? {}
        : { result: errorText }),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Observational-memory sealing persists progressive snapshots of the same
 * accumulating assistant message under fresh row ids, so one logical tool call
 * can appear in several assistant rows. Hydration keeps the FIRST occurrence
 * (preserving execution order) and merges richer fields (result, error flag)
 * from later duplicates into it.
 */
function dedupeHistoryToolCallPart(
  part: AssistantHistoryToolCallPart,
  seenToolCallsById: Map<string, AssistantHistoryToolCallPart>
): AssistantHistoryToolCallPart | undefined {
  const existing = seenToolCallsById.get(part.toolCallId);
  if (!existing) {
    seenToolCallsById.set(part.toolCallId, part);
    return part;
  }
  const mutable = existing as { result?: unknown; isError?: boolean };
  if (!Object.hasOwn(existing, 'result') && Object.hasOwn(part, 'result')) {
    mutable.result = (part as { result?: unknown }).result;
  }
  if (existing.isError === undefined && part.isError !== undefined) {
    mutable.isError = part.isError;
  }
  return;
}

function resolveRawContentPart(
  record: Record<string, unknown>,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHydratedContentPart | undefined {
  if (record['type'] === 'text' && typeof record['text'] === 'string') {
    const text = record['text'].trim();
    return text ? { type: 'text', text } : undefined;
  }
  if (record['type'] === 'tool-call') {
    return toHistoryToolCallPart(record, toolResultsByCallId);
  }
  if (record['type'] === 'tool-invocation') {
    return toHistoryToolCallPartFromInvocation(record);
  }
  if (record['type'] === 'reasoning') {
    return toHistoryReasoningPart(record);
  }
  return;
}

function readPartCreatedAtMs(record: Record<string, unknown>): number | undefined {
  const value = record['createdAt'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toAssistantHistoryContentParts(
  value: unknown,
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>,
  seenToolCallsById?: Map<string, AssistantHistoryToolCallPart>
): TimedHistoryContentPart[] {
  const rawParts = readContentPartArray(value);
  if (!rawParts) {
    return toTextHistoryContentParts(value).map((part) => ({ part }));
  }

  const parts: TimedHistoryContentPart[] = [];
  for (const rawPart of rawParts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
      continue;
    }
    const record = rawPart as Record<string, unknown>;
    let resolved = resolveRawContentPart(record, toolResultsByCallId);
    if (resolved?.type === 'tool-call' && seenToolCallsById) {
      resolved = dedupeHistoryToolCallPart(resolved, seenToolCallsById);
    }
    if (resolved) {
      const at = readPartCreatedAtMs(record);
      parts.push(at === undefined ? { part: resolved } : { at, part: resolved });
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

/**
 * A run of consecutive assistant rows (split only by user/system rows; legacy
 * `role: 'tool'` rows do not break a run). Observational-memory sealing and
 * per-step saves split ONE live assistant turn into several rows, so a group
 * hydrates back into a single assistant-ui message — matching what the thread
 * looked like while it streamed.
 */
interface AssistantHistoryRowGroup {
  readonly kind: 'assistant-group';
  readonly parts: TimedHistoryContentPart[];
  readonly rows: AssistantHistoryMessage[];
}

interface AssistantHistorySingleUnit {
  readonly kind: 'user' | 'system';
  readonly message: AssistantHistoryMessage;
}

type AssistantHistoryUnit = AssistantHistoryRowGroup | AssistantHistorySingleUnit;

function runEventTimeMs(eventPart: AssistantRunEventDataPart): number {
  const ms = Date.parse(eventPart.data.timestamp);
  // Unparseable timestamps surface at the front of the group (the legacy
  // prepend position) instead of being dropped.
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Tool-invocation parts rarely carry their own persisted timestamp, but every
 * tool execution emits a `tool.started` run event whose metadata names the
 * toolCallId — re-time each tool-call part to its own start event so reloaded
 * calls sit exactly where they executed instead of clumping at a snapshot
 * boundary.
 */
function applyToolEventTimes(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[]
): readonly TimedHistoryContentPart[] {
  const startTimesByToolCallId = new Map<string, number>();
  for (const eventPart of eventParts) {
    if (eventPart.data.kind !== 'tool.started') {
      continue;
    }
    const toolCallId = eventPart.data.metadata?.['toolCallId'];
    if (typeof toolCallId !== 'string' || startTimesByToolCallId.has(toolCallId)) {
      continue;
    }
    const ms = Date.parse(eventPart.data.timestamp);
    if (!Number.isNaN(ms)) {
      startTimesByToolCallId.set(toolCallId, ms);
    }
  }
  if (startTimesByToolCallId.size === 0) {
    return parts;
  }
  return parts.map((timed) => {
    if (timed.part.type !== 'tool-call') {
      return timed;
    }
    const ms = startTimesByToolCallId.get(timed.part.toolCallId);
    return ms === undefined ? timed : { at: ms, part: timed.part };
  });
}

/**
 * Interleave run events with content parts in live order: each event is
 * emitted before the first content part produced after it. Parts without a
 * persisted timestamp inherit the previous part's moment, so relative content
 * order is never changed.
 */
function weaveRunEventsIntoContent(
  parts: readonly TimedHistoryContentPart[],
  eventParts: readonly AssistantRunEventDataPart[],
  groupStartMs: number
): Array<AssistantHydratedContentPart | AssistantRunEventDataPart> {
  if (eventParts.length === 0) {
    return parts.map((timed) => timed.part);
  }
  const woven: Array<AssistantHydratedContentPart | AssistantRunEventDataPart> = [];
  let eventIndex = 0;
  let lastAt = groupStartMs;
  for (const timed of parts) {
    const at = timed.at ?? lastAt;
    lastAt = at;
    while (eventIndex < eventParts.length) {
      const eventPart = eventParts[eventIndex];
      if (!eventPart || runEventTimeMs(eventPart) > at) {
        break;
      }
      woven.push(eventPart);
      eventIndex += 1;
    }
    woven.push(timed.part);
  }
  for (; eventIndex < eventParts.length; eventIndex += 1) {
    const eventPart = eventParts[eventIndex];
    if (eventPart) {
      woven.push(eventPart);
    }
  }
  return woven;
}

function appendAssistantGroupMessage(args: {
  group: AssistantHistoryRowGroup;
  groupEventParts: readonly AssistantRunEventDataPart[];
  parentId: string | null;
  repositoryMessages: AssistantHistoryRepositoryMessages;
}): string | null {
  const firstRow = args.group.rows.at(0);
  const lastRow = args.group.rows.at(-1);
  if (!(firstRow && lastRow)) {
    return null;
  }
  // A group with no renderable parts of its own is still appended when it
  // carries run events — otherwise the persisted execution path would be
  // invisible after reload.
  if (args.group.parts.length === 0 && args.groupEventParts.length === 0) {
    return null;
  }
  const content = weaveRunEventsIntoContent(
    applyToolEventTimes(args.group.parts, args.groupEventParts),
    args.groupEventParts,
    firstRow.createdAt.getTime()
  );
  args.repositoryMessages.push({
    parentId: args.parentId,
    message: {
      id: lastRow.id,
      role: 'assistant',
      content,
      createdAt: firstRow.createdAt,
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
  return lastRow.id;
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

/**
 * Partition the row stream into units: user/system rows stand alone;
 * consecutive assistant rows collapse into one group (legacy `role: 'tool'`
 * rows neither render nor break a group). Conversion happens here exactly
 * once per row, in chronological order — the tool-call dedupe map is stateful
 * (it keeps the FIRST occurrence of each toolCallId across snapshot rows), so
 * re-converting a row would corrupt it.
 */
function buildHistoryUnits(
  messages: readonly AssistantHistoryMessage[],
  toolResultsByCallId: ReadonlyMap<string, AssistantToolResultSnapshot>
): AssistantHistoryUnit[] {
  const units: AssistantHistoryUnit[] = [];
  const seenToolCallsById = new Map<string, AssistantHistoryToolCallPart>();
  let openGroup: { rows: AssistantHistoryMessage[]; parts: TimedHistoryContentPart[] } | null =
    null;

  for (const message of messages) {
    if (message.role === 'assistant') {
      openGroup ??= { rows: [], parts: [] };
      openGroup.rows.push(message);
      // Parts without a persisted timestamp anchor to their snapshot row's
      // save time — each row seals shortly after its parts were produced.
      const rowMs = message.createdAt.getTime();
      openGroup.parts.push(
        ...toAssistantHistoryContentParts(
          message.content,
          toolResultsByCallId,
          seenToolCallsById
        ).map((timed) => (timed.at === undefined ? { at: rowMs, part: timed.part } : timed))
      );
      continue;
    }
    if (message.role === 'user' || message.role === 'system') {
      if (openGroup) {
        units.push({ kind: 'assistant-group', ...openGroup });
        openGroup = null;
      }
      units.push({ kind: message.role, message });
    }
    // Other roles (legacy 'tool' rows) are folded into tool results and never
    // rendered — they intentionally do not split an assistant group.
  }
  if (openGroup) {
    units.push({ kind: 'assistant-group', ...openGroup });
  }
  return units;
}

/**
 * Anchor the thread's run events to the LAST assistant group. The event
 * source (listThreadRunEvents) returns ONLY the latest run's events, and a
 * run's early events (memory loads, tool starts) occur BEFORE that run's
 * first assistant row is saved — splitting by time against group start times
 * assigned those early events to the PREVIOUS turn's group on reload.
 */
function assignRunEventsToGroups(
  units: readonly AssistantHistoryUnit[],
  runEvents: readonly AssistantRunEvent[]
): Map<AssistantHistoryUnit, AssistantRunEventDataPart[]> {
  const assignments = new Map<AssistantHistoryUnit, AssistantRunEventDataPart[]>();
  const lastGroup = units.findLast((unit) => unit.kind === 'assistant-group');
  if (!lastGroup || runEvents.length === 0) {
    return assignments;
  }
  assignments.set(lastGroup, toRunEventDataParts(runEvents));
  return assignments;
}

function toHistoryRepository(
  messages: readonly AssistantHistoryMessage[],
  runEvents: readonly AssistantRunEvent[] = []
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const repositoryMessages: Awaited<
    ReturnType<AssistantUiThreadHistoryAdapter['load']>
  >['messages'] = [];
  let parentId: string | null = null;
  const toolResultsByCallId = collectToolResults(messages);
  const units = buildHistoryUnits(messages, toolResultsByCallId);
  const runEventAssignments = assignRunEventsToGroups(units, runEvents);

  for (const unit of units) {
    if (unit.kind === 'assistant-group') {
      const appendedId = appendAssistantGroupMessage({
        group: unit,
        groupEventParts: runEventAssignments.get(unit) ?? [],
        parentId,
        repositoryMessages,
      });
      if (appendedId !== null) {
        parentId = appendedId;
      }
      continue;
    }
    const appended =
      unit.kind === 'user'
        ? appendUserHistoryMessage({ message: unit.message, parentId, repositoryMessages })
        : appendSystemHistoryMessage({ message: unit.message, parentId, repositoryMessages });
    if (appended) {
      parentId = unit.message.id;
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
    async recordRunUsage(input: RecordRunUsageInput): Promise<void> {
      assertUsageTokenCount(input.inputTokens, 'inputTokens');
      assertUsageTokenCount(input.outputTokens, 'outputTokens');
      await initialize();
      await database.query(
        `INSERT INTO ${ASSISTANT_RUN_USAGE_TABLE}
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          input.threadId,
          input.runId,
          input.resourceId,
          input.model,
          input.provider,
          input.inputTokens,
          input.outputTokens,
          new Date(),
        ]
      );
    },
    async getThreadCumulativeUsage(threadId: string): Promise<ThreadCumulativeUsage | null> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT
            provider,
            model,
            SUM(input_tokens)::bigint AS "inputTokens",
            SUM(output_tokens)::bigint AS "outputTokens"
         FROM ${ASSISTANT_RUN_USAGE_TABLE}
         WHERE thread_id = $1
         GROUP BY provider, model
         ORDER BY provider ASC, model ASC`,
        [threadId]
      );
      if (result.rows.length === 0) {
        return null;
      }
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const perModel = result.rows.map((row) => {
        const inputTokens = requireNonNegativeInteger(row['inputTokens'], 'inputTokens');
        const outputTokens = requireNonNegativeInteger(row['outputTokens'], 'outputTokens');
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        return {
          provider: requireString(row['provider'], 'provider'),
          model: requireString(row['model'], 'model'),
          inputTokens,
          outputTokens,
        } satisfies ThreadModelUsageSubtotal;
      });
      return { perModel, totalInputTokens, totalOutputTokens };
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
      assertPersistableThreadMetadata(metadata);
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
