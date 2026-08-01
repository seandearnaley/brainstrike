import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type {
  BufferedObservationChunk,
  ObservationalMemoryRecord,
  StorageResourceType,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
} from '@mastra/core/storage';
import {
  type MessageListArgs,
  parseJsonArray,
  parseJsonRecord,
  parseMessageContent,
  toDate,
  toOptionalDate,
} from './memory-query-helpers';

export interface ThreadRow {
  createdAt: Date | string;
  id: string;
  metadata: Record<string, unknown> | string | null;
  resourceId: string;
  title: string;
  updatedAt: Date | string;
  [key: string]: unknown;
}

export interface MessageRow {
  content: MastraDBMessage['content'] | string;
  createdAt: Date | string;
  id: string;
  resourceId: string | null;
  role: MastraDBMessage['role'];
  threadId: string;
  type: MastraDBMessage['type'];
  [key: string]: unknown;
}

export interface ResourceRow {
  createdAt: Date | string;
  id: string;
  metadata: Record<string, unknown> | string | null;
  updatedAt: Date | string;
  workingMemory: string | null;
  [key: string]: unknown;
}

export interface CountRow {
  count: number | string;
  [key: string]: unknown;
}

export interface ObservationalMemoryRow {
  activeObservations: string;
  activeObservationsPendingUpdate: string | null;
  bufferedMessageIds: string[] | string | null;
  bufferedObservationChunks: ObservationalMemoryRecord['bufferedObservationChunks'] | string | null;
  bufferedObservations: string | null;
  bufferedObservationTokens: number | null;
  bufferedReflection: string | null;
  bufferedReflectionInputTokens: number | null;
  bufferedReflectionTokens: number | null;
  config: string;
  createdAt: Date | string;
  generationCount: number;
  id: string;
  isBufferingObservation: boolean;
  isBufferingReflection: boolean;
  isObserving: boolean;
  isReflecting: boolean;
  lastBufferedAtTime: Date | string | null;
  lastBufferedAtTokens: number;
  lastObservedAt: Date | string | null;
  lastReflectionAt: Date | string | null;
  lookupKey: string;
  metadata: Record<string, unknown> | string | null;
  observationTokenCount: number;
  observedMessageIds: string[] | string | null;
  observedTimezone: string | null;
  originType: ObservationalMemoryRecord['originType'];
  pendingMessageTokens: number;
  reflectedObservationLineCount: number | null;
  resourceId: string | null;
  scope: ObservationalMemoryRecord['scope'];
  threadId: string | null;
  totalTokensObserved: number;
  updatedAt: Date | string;
  [key: string]: unknown;
}

export function messageRowMatchesListScope(row: MessageRow, args: MessageListArgs): boolean {
  if (args.threadIds && !args.threadIds.includes(row.threadId)) {
    return false;
  }
  if (args.resourceId && row.resourceId !== args.resourceId) {
    return false;
  }
  return true;
}

export function threadFromRow(row: ThreadRow): StorageThreadType {
  const thread: StorageThreadType = {
    createdAt: toDate(row.createdAt),
    id: row.id,
    resourceId: row.resourceId,
    title: row.title,
    updatedAt: toDate(row.updatedAt),
  };
  const metadata = parseJsonRecord(row.metadata);
  if (metadata) {
    thread.metadata = metadata;
  }
  return thread;
}

export function messageFromRow(row: MessageRow): MastraDBMessage {
  return {
    content: parseMessageContent(row.content),
    createdAt: toDate(row.createdAt),
    id: row.id,
    role: row.role,
    threadId: row.threadId,
    type: row.type,
    ...(row.resourceId === null ? {} : { resourceId: row.resourceId }),
  } as MastraDBMessage;
}

export function resourceFromRow(row: ResourceRow): StorageResourceType {
  const resource: StorageResourceType = {
    createdAt: toDate(row.createdAt),
    id: row.id,
    updatedAt: toDate(row.updatedAt),
  };
  if (row.workingMemory !== null) {
    resource.workingMemory = row.workingMemory;
  }
  const metadata = parseJsonRecord(row.metadata);
  if (metadata) {
    resource.metadata = metadata;
  }
  return resource;
}

export function observationalMemoryKey(threadId: string | null, resourceId: string): string {
  return threadId ? `thread:${threadId}` : `resource:${resourceId}`;
}

function normalizeBufferedChunks(
  value: ObservationalMemoryRow['bufferedObservationChunks']
): ObservationalMemoryRecord['bufferedObservationChunks'] {
  const chunks = parseJsonArray<
    NonNullable<ObservationalMemoryRecord['bufferedObservationChunks']>[number]
  >(value ?? null);
  return chunks?.map((chunk) => ({
    ...chunk,
    createdAt: toDate(chunk.createdAt),
    lastObservedAt: toDate(chunk.lastObservedAt),
  }));
}

export function observationalMemoryFromRow(row: ObservationalMemoryRow): ObservationalMemoryRecord {
  const record: ObservationalMemoryRecord = {
    activeObservations: row.activeObservations,
    config: parseJsonRecord(row.config) ?? {},
    createdAt: toDate(row.createdAt),
    generationCount: row.generationCount,
    id: row.id,
    isBufferingObservation: row.isBufferingObservation,
    isBufferingReflection: row.isBufferingReflection,
    isObserving: row.isObserving,
    isReflecting: row.isReflecting,
    lastBufferedAtTime: row.lastBufferedAtTime ? toDate(row.lastBufferedAtTime) : null,
    lastBufferedAtTokens: row.lastBufferedAtTokens,
    observationTokenCount: row.observationTokenCount,
    originType: row.originType,
    pendingMessageTokens: row.pendingMessageTokens,
    resourceId: row.resourceId ?? '',
    scope: row.scope,
    threadId: row.threadId,
    totalTokensObserved: row.totalTokensObserved,
    updatedAt: toDate(row.updatedAt),
  };
  const lastObservedAt = toOptionalDate(row.lastObservedAt);
  if (lastObservedAt) {
    record.lastObservedAt = lastObservedAt;
  }
  const bufferedObservationChunks = normalizeBufferedChunks(row.bufferedObservationChunks);
  if (bufferedObservationChunks) {
    record.bufferedObservationChunks = bufferedObservationChunks;
  }
  if (row.bufferedObservations !== null) {
    record.bufferedObservations = row.bufferedObservations;
  }
  if (row.bufferedObservationTokens !== null) {
    record.bufferedObservationTokens = row.bufferedObservationTokens;
  }
  const bufferedMessageIds = parseJsonArray<string>(row.bufferedMessageIds);
  if (bufferedMessageIds) {
    record.bufferedMessageIds = bufferedMessageIds;
  }
  if (row.bufferedReflection !== null) {
    record.bufferedReflection = row.bufferedReflection;
  }
  if (row.bufferedReflectionTokens !== null) {
    record.bufferedReflectionTokens = row.bufferedReflectionTokens;
  }
  if (row.bufferedReflectionInputTokens !== null) {
    record.bufferedReflectionInputTokens = row.bufferedReflectionInputTokens;
  }
  if (row.reflectedObservationLineCount !== null) {
    record.reflectedObservationLineCount = row.reflectedObservationLineCount;
  }
  const observedMessageIds = parseJsonArray<string>(row.observedMessageIds);
  if (observedMessageIds) {
    record.observedMessageIds = observedMessageIds;
  }
  if (row.observedTimezone) {
    record.observedTimezone = row.observedTimezone;
  }
  const metadata = parseJsonRecord(row.metadata);
  if (metadata) {
    record.metadata = metadata;
  }
  return record;
}

interface BufferedActivationChoice {
  count: number;
}

export function chooseBufferedActivationCount(
  chunks: BufferedObservationChunk[],
  input: SwapBufferedToActiveInput
): BufferedActivationChoice {
  const retentionFloor = input.messageTokensThreshold * (1 - input.activationRatio);
  const targetMessageTokens = Math.max(0, input.currentPendingTokens - retentionFloor);
  let cumulativeMessageTokens = 0;
  let bestOverBoundary = 0;
  let bestOverTokens = 0;
  let bestUnderBoundary = 0;
  let bestUnderTokens = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    cumulativeMessageTokens += chunks[index]?.messageTokens ?? 0;
    const boundary = index + 1;
    if (cumulativeMessageTokens >= targetMessageTokens) {
      if (bestOverBoundary === 0 || cumulativeMessageTokens < bestOverTokens) {
        bestOverBoundary = boundary;
        bestOverTokens = cumulativeMessageTokens;
      }
    } else if (cumulativeMessageTokens > bestUnderTokens) {
      bestUnderBoundary = boundary;
      bestUnderTokens = cumulativeMessageTokens;
    }
  }

  const maxOvershoot = retentionFloor * 0.95;
  const overshoot = bestOverTokens - targetMessageTokens;
  const remainingAfterOver = input.currentPendingTokens - bestOverTokens;
  const remainingAfterUnder = input.currentPendingTokens - bestUnderTokens;
  const minRemaining = Math.min(1000, retentionFloor);
  if (input.forceMaxActivation && bestOverBoundary > 0 && remainingAfterOver >= minRemaining) {
    return { count: bestOverBoundary };
  }
  if (bestOverBoundary > 0 && overshoot <= maxOvershoot && remainingAfterOver >= minRemaining) {
    return { count: bestOverBoundary };
  }
  if (bestUnderBoundary > 0 && remainingAfterUnder >= minRemaining) {
    return { count: bestUnderBoundary };
  }
  return { count: bestOverBoundary > 0 ? bestOverBoundary : 1 };
}

export function emptyBufferedActivation(): SwapBufferedToActiveResult {
  return {
    activatedCycleIds: [],
    activatedMessageIds: [],
    chunksActivated: 0,
    messagesActivated: 0,
    messageTokensActivated: 0,
    observationTokensActivated: 0,
  };
}

export function withoutBufferedObservationChunks(
  record: ObservationalMemoryRecord
): ObservationalMemoryRecord {
  const { bufferedObservationChunks: _bufferedObservationChunks, ...rest } = record;
  return rest;
}

export function withoutBufferedReflection(
  record: ObservationalMemoryRecord
): ObservationalMemoryRecord {
  const {
    bufferedReflection: _bufferedReflection,
    bufferedReflectionInputTokens: _bufferedReflectionInputTokens,
    bufferedReflectionTokens: _bufferedReflectionTokens,
    reflectedObservationLineCount: _reflectedObservationLineCount,
    ...rest
  } = record;
  return rest;
}
