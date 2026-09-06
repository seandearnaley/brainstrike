import {
  ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES,
  ASSISTANT_EDIT_CHECKPOINT_OPS,
  type AssistantEditCheckpointCaptureStatus,
  type AssistantEditCheckpointOp,
  type AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { DEFAULT_THREAD_TITLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  ASSISTANT_RUN_EVENT_KINDS,
  ASSISTANT_RUN_EVENT_STATUSES,
  type AssistantRunEvent,
  type AssistantRunEventKind,
  type AssistantRunEventStatus,
  sanitizeAssistantRunEventMetadata,
} from '@brainstrike/assistant-contract/run-events';
import {
  ASSISTANT_RUN_USAGE_KINDS,
  type AssistantRunUsageKind,
} from '@brainstrike/assistant-contract/run-usage';
import { sanitizeThreadMetadata } from './assistant-thread-metadata.js';
import type {
  AssistantHistoryMessage,
  AssistantMemoryThread,
  AssistantThreadRunRecord,
  AssistantThreadRunStatus,
  AssistantThreadRuntimeKind,
} from './assistant-thread-types.js';
import {
  getRowValue,
  isFiniteInteger,
  normalizeDate,
  normalizeNullableDate,
  nullableInteger,
  nullableString,
  optionalJsonRecord,
  parseJson,
  requireNonEmptyTopologyId,
  requireString,
} from './assistant-value-coercion.js';

export function toMemoryThread(thread: {
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
    createdAt: normalizeDate(thread.createdAt),
    id: thread.id,
    resourceId: thread.resourceId,
    title: thread.title?.trim() || DEFAULT_THREAD_TITLE,
    updatedAt: normalizeDate(thread.updatedAt),
    ...(thread.latestRun ? { latestRun: thread.latestRun } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function mapAssistantHistoryMessageRow(
  row: Record<string, unknown>
): AssistantHistoryMessage {
  const parentMappingMessageId = row['parentMappingMessageId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    requireNonEmptyTopologyId(parentMappingMessageId, 'parentMappingMessageId');
  }
  const parentId = row['parentId'];
  if (parentMappingMessageId !== null && parentMappingMessageId !== undefined) {
    if (parentId !== null) {
      requireNonEmptyTopologyId(parentId, 'parentId');
    }
  } else if (parentId !== null && parentId !== undefined) {
    throw new Error('Assistant message parent exists without a mapping row.');
  }
  return {
    content: parseJson(row['content']),
    createdAt: normalizeDate(row['createdAt']),
    id: requireString(row['id'], 'id'),
    ...(parentMappingMessageId === null || parentMappingMessageId === undefined
      ? {}
      : { parentId: parentId === null ? null : (parentId as string) }),
    role: requireString(row['role'], 'role'),
  };
}

export function requireRunStatus(value: unknown): AssistantThreadRunStatus {
  if (value === 'cancelled' || value === 'completed' || value === 'failed' || value === 'running') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: status is not valid.');
}

export function requireRunUsageKind(value: unknown): AssistantRunUsageKind {
  if (
    typeof value === 'string' &&
    (ASSISTANT_RUN_USAGE_KINDS as readonly string[]).includes(value)
  ) {
    return value as AssistantRunUsageKind;
  }
  throw new Error('Invalid assistant run usage row: run_kind is not valid.');
}

function requireRuntimeKind(value: unknown): AssistantThreadRuntimeKind {
  if (value === 'browser' || value === 'gateway' || value === 'hosted' || value === 'local') {
    return value;
  }
  throw new Error('Invalid assistant thread run row: runtime_kind is not valid.');
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

export function toThreadRunEvent(row: Record<string, unknown>): AssistantRunEvent {
  const metadata = optionalJsonRecord(row['metadata']);
  const sanitizedMetadata = sanitizeAssistantRunEventMetadata(metadata);
  const detail = nullableString(row['detail']);
  const durationRaw = getRowValue(row, 'durationMs', 'duration_ms');
  const durationMs = isFiniteInteger(durationRaw) ? durationRaw : undefined;
  const event: AssistantRunEvent = {
    id: requireString(row['id'], 'id'),
    kind: requireRunEventKind(row['kind']),
    label: requireString(row['label'], 'label'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    sequence: isFiniteInteger(row['sequence']) ? row['sequence'] : Number(row['sequence']),
    status: requireRunEventStatus(row['status']),
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

function requireCheckpointOp(value: unknown): AssistantEditCheckpointOp {
  if (
    typeof value === 'string' &&
    (ASSISTANT_EDIT_CHECKPOINT_OPS as readonly string[]).includes(value)
  ) {
    return value as AssistantEditCheckpointOp;
  }
  throw new Error(`Invalid edit checkpoint row: op "${String(value)}" is not valid.`);
}

function requireCheckpointCaptureStatus(value: unknown): AssistantEditCheckpointCaptureStatus {
  if (
    typeof value === 'string' &&
    (ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as AssistantEditCheckpointCaptureStatus;
  }
  throw new Error(`Invalid edit checkpoint row: capture_status "${String(value)}" is not valid.`);
}

export function toEditCheckpointRecord(
  row: Record<string, unknown>
): AssistantEditCheckpointRecord {
  const revertedAt = normalizeNullableDate(getRowValue(row, 'revertedAt', 'reverted_at'));
  return {
    afterExisted: Boolean(getRowValue(row, 'afterExisted', 'after_existed')),
    afterHash: nullableString(getRowValue(row, 'afterHash', 'after_hash')),
    beforeExisted: Boolean(getRowValue(row, 'beforeExisted', 'before_existed')),
    beforeHash: nullableString(getRowValue(row, 'beforeHash', 'before_hash')),
    beforeSize: nullableInteger(getRowValue(row, 'beforeSize', 'before_size')),
    captureStatus: requireCheckpointCaptureStatus(
      getRowValue(row, 'captureStatus', 'capture_status')
    ),
    fromPath: nullableString(getRowValue(row, 'fromPath', 'from_path')),
    id: requireString(row['id'], 'id'),
    occurredAt: normalizeDate(getRowValue(row, 'occurredAt', 'occurred_at')).toISOString(),
    op: requireCheckpointOp(row['op']),
    path: requireString(row['path'], 'path'),
    resourceId: requireString(getRowValue(row, 'resourceId', 'resource_id'), 'resourceId'),
    revertedAt: revertedAt ? revertedAt.toISOString() : null,
    rootId: requireString(getRowValue(row, 'rootId', 'root_id'), 'rootId'),
    runId: requireString(getRowValue(row, 'runId', 'run_id'), 'runId'),
    threadId: requireString(getRowValue(row, 'threadId', 'thread_id'), 'threadId'),
    toolCallId: nullableString(getRowValue(row, 'toolCallId', 'tool_call_id')),
    toolName: requireString(getRowValue(row, 'toolName', 'tool_name'), 'toolName'),
  };
}

export function toThreadRunRecord(row: Record<string, unknown>): AssistantThreadRunRecord {
  const modelSettings = optionalJsonRecord(getRowValue(row, 'modelSettings', 'model_settings'));
  const providerOptions = optionalJsonRecord(
    getRowValue(row, 'providerOptions', 'provider_options')
  );

  return {
    completedAt: normalizeNullableDate(getRowValue(row, 'completedAt', 'completed_at')),
    createdAt: normalizeDate(getRowValue(row, 'createdAt', 'created_at')),
    error: nullableString(row['error']),
    id: requireString(row['id'], 'id'),
    model: requireString(row['model'], 'model'),
    provider: requireString(row['provider'], 'provider'),
    resourceId: requireString(getRowValue(row, 'resourceId', 'resource_id'), 'resourceId'),
    runtimeKind: requireRuntimeKind(getRowValue(row, 'runtimeKind', 'runtime_kind')),
    startedAt: normalizeDate(getRowValue(row, 'startedAt', 'started_at')),
    status: requireRunStatus(row['status']),
    threadId: requireString(getRowValue(row, 'threadId', 'thread_id'), 'threadId'),
    turnMessageId: nullableString(getRowValue(row, 'turnMessageId', 'turn_message_id')),
    updatedAt: normalizeDate(getRowValue(row, 'updatedAt', 'updated_at')),
    ...(modelSettings ? { modelSettings } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

export function toLatestThreadRunRecord(
  threadRow: Record<string, unknown>
): AssistantThreadRunRecord | undefined {
  const id = threadRow['latestRunId'];
  if (id === null || id === undefined) {
    return;
  }
  return toThreadRunRecord({
    completedAt: threadRow['latestRunCompletedAt'],
    createdAt: threadRow['latestRunCreatedAt'],
    error: threadRow['latestRunError'],
    id,
    model: threadRow['latestRunModel'],
    modelSettings: threadRow['latestRunModelSettings'],
    provider: threadRow['latestRunProvider'],
    providerOptions: threadRow['latestRunProviderOptions'],
    resourceId: threadRow['latestRunResourceId'],
    runtimeKind: threadRow['latestRunRuntimeKind'],
    startedAt: threadRow['latestRunStartedAt'],
    status: threadRow['latestRunStatus'],
    threadId: threadRow['latestRunThreadId'],
    turnMessageId: threadRow['latestRunTurnMessageId'],
    updatedAt: threadRow['latestRunUpdatedAt'],
  });
}

export function toRunEventDataParts(runEvents: readonly AssistantRunEvent[]): Array<{
  readonly data: AssistantRunEvent;
  readonly name: typeof ASSISTANT_RUN_EVENT_DATA_NAME;
  readonly type: 'data';
}> {
  return runEvents.map((event) => ({
    data: event,
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data' as const,
  }));
}
