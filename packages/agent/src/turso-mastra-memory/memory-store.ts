import { createLogger, getErrorMessage } from '@brainstrike/utils';
import type { MastraMessageContentV2 } from '@mastra/core/agent';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type {
  BufferedObservationChunk,
  CreateObservationalMemoryInput,
  CreateReflectionGenerationInput,
  ObservationalMemoryHistoryOptions,
  ObservationalMemoryRecord,
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  StorageListMessagesOutput,
  StorageListThreadsInput,
  StorageListThreadsOutput,
  StorageResourceType,
  SwapBufferedReflectionToActiveInput,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
  ThreadOrderBy,
  ThreadSortDirection,
  UpdateActiveObservationsInput,
  UpdateBufferedObservationsInput,
  UpdateBufferedReflectionInput,
  UpdateObservationalMemoryConfigInput,
} from '@mastra/core/storage';
import { MemoryStorage } from '@mastra/core/storage';
import {
  type AssistantRunEventKind,
  type AssistantRunEventMetadata,
  type AssistantRunEventSink,
  type AssistantRunEventStatus,
  emitAssistantRunEventSafely,
} from '../run-events';
import { MASTRA_MEMORY_SCHEMA_SQL, MASTRA_MEMORY_TABLES } from './sql';
import type { TursoMastraQueryValue, TursoMastraSqlClient } from './types';

const logger = createLogger('TursoMemoryStore');

interface TursoMemoryStoreOptions {
  database: TursoMastraSqlClient;
  eventSink?: AssistantRunEventSink;
  runId?: string;
}

interface ThreadRow {
  createdAt: Date | string;
  id: string;
  metadata: Record<string, unknown> | string | null;
  resourceId: string;
  title: string;
  updatedAt: Date | string;
  [key: string]: unknown;
}

interface MessageRow {
  content: MastraDBMessage['content'] | string;
  createdAt: Date | string;
  id: string;
  resourceId: string | null;
  role: MastraDBMessage['role'];
  threadId: string;
  type: MastraDBMessage['type'];
  [key: string]: unknown;
}

interface ResourceRow {
  createdAt: Date | string;
  id: string;
  metadata: Record<string, unknown> | string | null;
  updatedAt: Date | string;
  workingMemory: string | null;
  [key: string]: unknown;
}

interface CountRow {
  count: number | string;
  [key: string]: unknown;
}

type MessageListArgs = (StorageListMessagesInput | StorageListMessagesByResourceIdInput) & {
  threadIds?: string[];
};
type MessageIncludeItem = NonNullable<StorageListMessagesInput['include']>[number];

interface ObservationalMemoryRow {
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
  isBufferingObservation: boolean | number;
  isBufferingReflection: boolean | number;
  isObserving: boolean | number;
  isReflecting: boolean | number;
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

const DEFAULT_THREADS_PER_PAGE = 100;
const DEFAULT_MESSAGES_PER_PAGE = 40;
const THREAD_ORDER_FIELDS = new Set<ThreadOrderBy>(['createdAt', 'updatedAt']);
const THREAD_ORDER_DIRECTIONS = new Set<ThreadSortDirection>(['ASC', 'DESC']);

/** Inline run-event detail like "12 messages" / "1 record". */
function formatCountDetail(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toSqlDate(value: Date | string): string {
  return toDate(value).toISOString();
}

function toOptionalDate(value: Date | string | null): Date | undefined {
  return value ? toDate(value) : undefined;
}

function toJsonString(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseJsonRecord(
  value: Record<string, unknown> | string | null
): Record<string, unknown> | undefined {
  if (!value) {
    return;
  }
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }
  return value;
}

function parseJsonArray<TValue>(value: TValue[] | string | null): TValue[] | undefined {
  if (!value) {
    return;
  }
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as TValue[]) : undefined;
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqlBoolean(value: boolean | number): boolean {
  return typeof value === 'boolean' ? value : value === 1;
}

function parseMessageContent(
  value: MastraDBMessage['content'] | string
): MastraDBMessage['content'] {
  if (typeof value !== 'string') {
    return value;
  }
  const parsed: unknown = JSON.parse(value);
  return parsed as MastraDBMessage['content'];
}

function normalizePerPage(
  value: number | false | undefined,
  defaultPerPage: number
): number | false {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return defaultPerPage;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('perPage must be false or a non-negative safe integer');
  }
  return value;
}

function normalizePage(value: number | undefined): number {
  const page = value ?? 0;
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new Error('page must be a non-negative safe integer');
  }
  return page;
}

function pagination(total: number, page: number, perPage: number | false) {
  if (perPage === false) {
    return { total, page: 0, perPage, hasMore: false };
  }
  return {
    total,
    page,
    perPage,
    hasMore: (page + 1) * perPage < total,
  };
}

function orderBySql(
  orderBy: { field?: ThreadOrderBy | 'createdAt'; direction?: ThreadSortDirection } | undefined,
  defaultField: ThreadOrderBy,
  defaultDirection: ThreadSortDirection
): string {
  const field = (orderBy?.field ?? defaultField) as ThreadOrderBy;
  const direction = orderBy?.direction ?? defaultDirection;
  if (!THREAD_ORDER_FIELDS.has(field)) {
    throw new Error(`Unsupported order field: ${field}`);
  }
  if (!THREAD_ORDER_DIRECTIONS.has(direction)) {
    throw new Error(`Unsupported order direction: ${direction}`);
  }
  return `"${field}" ${direction}, id ${direction}`;
}

function normalizeMessageOrder(orderBy: StorageListMessagesInput['orderBy'] | undefined): {
  direction: ThreadSortDirection;
} {
  const field = orderBy?.field ?? 'createdAt';
  const direction = orderBy?.direction ?? 'DESC';
  if (field !== 'createdAt') {
    throw new Error(`Unsupported message order field: ${field}`);
  }
  if (!THREAD_ORDER_DIRECTIONS.has(direction)) {
    throw new Error(`Unsupported order direction: ${direction}`);
  }
  return { direction };
}

function compareMessagesByOrder(
  left: MastraDBMessage,
  right: MastraDBMessage,
  order: { direction: ThreadSortDirection }
): number {
  const leftTime = toDate(left.createdAt).getTime();
  const rightTime = toDate(right.createdAt).getTime();
  const dateDelta = leftTime - rightTime;
  if (dateDelta !== 0) {
    return order.direction === 'ASC' ? dateDelta : -dateDelta;
  }
  return order.direction === 'ASC'
    ? left.id.localeCompare(right.id)
    : right.id.localeCompare(left.id);
}

function normalizeIncludeWindowCount(value: number | undefined, label: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeIncludeThreadId(threadId: string | undefined, defaultThreadId: string): string {
  if (threadId === undefined) {
    return defaultThreadId;
  }
  if (!threadId.trim()) {
    throw new Error('include.threadId must be a non-empty string when provided');
  }
  return threadId;
}

function messageMatchesListScope(message: MastraDBMessage, args: MessageListArgs): boolean {
  if (args.threadIds) {
    const threadId = message.threadId;
    if (!(threadId && args.threadIds.includes(threadId))) {
      return false;
    }
  }
  if (args.resourceId && message.resourceId !== args.resourceId) {
    return false;
  }
  return true;
}

function createdAtMatchesDateRange(createdAt: Date | string, args: MessageListArgs): boolean {
  const dateRange = args.filter?.dateRange;
  if (!dateRange) {
    return true;
  }
  const time = toDate(createdAt).getTime();
  if (dateRange.start) {
    const startTime = toDate(dateRange.start).getTime();
    if (dateRange.startExclusive ? time <= startTime : time < startTime) {
      return false;
    }
  }
  if (dateRange.end) {
    const endTime = toDate(dateRange.end).getTime();
    if (dateRange.endExclusive ? time >= endTime : time > endTime) {
      return false;
    }
  }
  return true;
}

function messageMatchesListFilters(message: MastraDBMessage, args: MessageListArgs): boolean {
  return (
    messageMatchesListScope(message, args) && createdAtMatchesDateRange(message.createdAt, args)
  );
}

function messageRowMatchesListScope(row: MessageRow, args: MessageListArgs): boolean {
  if (args.threadIds && !args.threadIds.includes(row.threadId)) {
    return false;
  }
  if (args.resourceId && row.resourceId !== args.resourceId) {
    return false;
  }
  return true;
}

function appendLimit(
  sql: string,
  values: TursoMastraQueryValue[],
  page: number,
  perPage: number | false
): string {
  if (perPage === false) {
    return sql;
  }
  values.push(perPage);
  values.push(page * perPage);
  return `${sql} LIMIT ? OFFSET ?`;
}

function appendInPredicate(
  columnSql: string,
  values: TursoMastraQueryValue[],
  entries: readonly string[]
): string {
  values.push(...entries);
  return `${columnSql} IN (${entries.map(() => '?').join(', ')})`;
}

function threadFromRow(row: ThreadRow): StorageThreadType {
  const thread: StorageThreadType = {
    id: row.id,
    resourceId: row.resourceId,
    title: row.title,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
  const metadata = parseJsonRecord(row.metadata);
  if (metadata) {
    thread.metadata = metadata;
  }
  return thread;
}

function messageFromRow(row: MessageRow): MastraDBMessage {
  return {
    id: row.id,
    role: row.role,
    type: row.type,
    threadId: row.threadId,
    createdAt: toDate(row.createdAt),
    content: parseMessageContent(row.content),
    ...(row.resourceId === null ? {} : { resourceId: row.resourceId }),
  } as MastraDBMessage;
}

function resourceFromRow(row: ResourceRow): StorageResourceType {
  const resource: StorageResourceType = {
    id: row.id,
    createdAt: toDate(row.createdAt),
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

function observationalMemoryKey(threadId: string | null, resourceId: string): string {
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

function observationalMemoryFromRow(row: ObservationalMemoryRow): ObservationalMemoryRecord {
  const record: ObservationalMemoryRecord = {
    id: row.id,
    scope: row.scope,
    threadId: row.threadId,
    resourceId: row.resourceId ?? '',
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    originType: row.originType,
    generationCount: row.generationCount,
    activeObservations: row.activeObservations,
    totalTokensObserved: row.totalTokensObserved,
    observationTokenCount: row.observationTokenCount,
    pendingMessageTokens: row.pendingMessageTokens,
    isReflecting: fromSqlBoolean(row.isReflecting),
    isObserving: fromSqlBoolean(row.isObserving),
    isBufferingObservation: fromSqlBoolean(row.isBufferingObservation),
    isBufferingReflection: fromSqlBoolean(row.isBufferingReflection),
    lastBufferedAtTokens: row.lastBufferedAtTokens,
    lastBufferedAtTime: row.lastBufferedAtTime ? toDate(row.lastBufferedAtTime) : null,
    config: parseJsonRecord(row.config) ?? {},
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

function chooseBufferedActivationCount(
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

function emptyBufferedActivation(): SwapBufferedToActiveResult {
  return {
    chunksActivated: 0,
    messageTokensActivated: 0,
    observationTokensActivated: 0,
    messagesActivated: 0,
    activatedCycleIds: [],
    activatedMessageIds: [],
  };
}

function withoutBufferedObservationChunks(
  record: ObservationalMemoryRecord
): ObservationalMemoryRecord {
  const { bufferedObservationChunks: _bufferedObservationChunks, ...rest } = record;
  return rest;
}

function withoutBufferedReflection(record: ObservationalMemoryRecord): ObservationalMemoryRecord {
  const {
    bufferedReflection: _bufferedReflection,
    bufferedReflectionInputTokens: _bufferedReflectionInputTokens,
    bufferedReflectionTokens: _bufferedReflectionTokens,
    reflectedObservationLineCount: _reflectedObservationLineCount,
    ...rest
  } = record;
  return rest;
}

export class TursoMemoryStore extends MemoryStorage {
  override readonly supportsObservationalMemory = true;
  private readonly database: TursoMastraSqlClient;
  private readonly eventSink: AssistantRunEventSink | undefined;
  private readonly runId: string | undefined;
  private initPromise: Promise<void> | null = null;

  constructor(options: TursoMemoryStoreOptions) {
    super();
    this.database = options.database;
    this.eventSink = options.eventSink;
    this.runId = options.runId;
  }

  override async init(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    this.initPromise ??= this.database
      .exec(MASTRA_MEMORY_SCHEMA_SQL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.initPromise = null;
        throw error;
      });
    await this.initPromise;
  }

  override async dangerouslyClearAll(): Promise<void> {
    await this.database.exec(`
      DELETE FROM ${MASTRA_MEMORY_TABLES.messages};
      DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory};
      DELETE FROM ${MASTRA_MEMORY_TABLES.resources};
      DELETE FROM ${MASTRA_MEMORY_TABLES.threads};
    `);
  }

  override async getThreadById({
    threadId,
    resourceId,
  }: {
    threadId: string;
    resourceId?: string;
  }): Promise<StorageThreadType | null> {
    const values: TursoMastraQueryValue[] = [threadId];
    const resourcePredicate = resourceId === undefined ? '' : ' AND "resourceId" = ?';
    if (resourceId !== undefined) {
      values.push(resourceId);
    }
    const result = await this.database.query<ThreadRow>(
      `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.threads}
       WHERE id = ?${resourcePredicate}`,
      values
    );
    const row = result.rows[0];
    return row ? threadFromRow(row) : null;
  }

  override async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
        (id, "resourceId", title, metadata, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
        "resourceId" = EXCLUDED."resourceId",
        title = EXCLUDED.title,
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        thread.id,
        thread.resourceId,
        thread.title ?? 'New Thread',
        toJsonString(thread.metadata),
        toSqlDate(thread.createdAt),
        toSqlDate(thread.updatedAt),
      ]
    );
    const saved = await this.getThreadById({ threadId: thread.id });
    if (!saved) {
      throw new Error(`Failed to save Mastra thread: ${thread.id}`);
    }
    return saved;
  }

  override async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const now = new Date();
    await this.database.query(
      `UPDATE ${MASTRA_MEMORY_TABLES.threads}
       SET title = ?, metadata = ?, "updatedAt" = ?
       WHERE id = ?`,
      [title, toJsonString(metadata), toSqlDate(now), id]
    );
    const updated = await this.getThreadById({ threadId: id });
    if (!updated) {
      throw new Error(`Mastra thread not found: ${id}`);
    }
    return updated;
  }

  override async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    await runTransaction(this.database, async (tx) => {
      await tx.query(
        `DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
         WHERE "threadId" = ? OR "lookupKey" = ?`,
        [threadId, `thread:${threadId}`]
      );
      await tx.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE thread_id = ?`, [
        threadId,
      ]);
      await tx.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.threads} WHERE id = ?`, [threadId]);
    });
  }

  override async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_THREADS_PER_PAGE);
    const where: string[] = [];
    const values: TursoMastraQueryValue[] = [];
    const filter = args.filter;

    if (filter?.resourceId !== undefined) {
      values.push(filter.resourceId);
      where.push('"resourceId" = ?');
    }
    if (filter?.metadata && Object.keys(filter.metadata).length > 0) {
      this.validateMetadataKeys(filter.metadata);
      for (const [key, value] of Object.entries(filter.metadata)) {
        values.push(value as TursoMastraQueryValue);
        where.push(`json_extract(metadata, '$.${key}') = ?`);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM ${MASTRA_MEMORY_TABLES.threads} ${whereSql}`,
      values
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const queryValues = [...values];
    const baseSql = `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.threads}
       ${whereSql}
       ORDER BY ${orderBySql(args.orderBy, 'createdAt', 'DESC')}`;
    const rows = await this.database.query<ThreadRow>(
      appendLimit(baseSql, queryValues, page, perPage),
      queryValues
    );

    return {
      threads: rows.rows.map(threadFromRow),
      ...pagination(total, page, perPage),
    };
  }

  override async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
    const threadIds = Array.isArray(args.threadId) ? args.threadId : [args.threadId];
    if (threadIds.length === 0 || threadIds.some((threadId) => !threadId.trim())) {
      throw new Error('threadId must be a non-empty string or array of non-empty strings');
    }
    const result = await this.listMessagesWhere({ ...args, threadIds });
    this.emitRunEvent(
      'memory.history.loaded',
      'completed',
      'Conversation history loaded',
      {
        count: result.messages.length,
        threadCount: threadIds.length,
      },
      formatCountDetail(result.messages.length, 'message')
    );
    return result;
  }

  override async listMessagesByResourceId(
    args: StorageListMessagesByResourceIdInput
  ): Promise<StorageListMessagesOutput> {
    const result = await this.listMessagesWhere(args);
    this.emitRunEvent(
      'memory.history.loaded',
      'completed',
      'Resource history loaded',
      {
        count: result.messages.length,
        resourceId: args.resourceId,
      },
      formatCountDetail(result.messages.length, 'message')
    );
    return result;
  }

  override async listMessagesById({ messageIds }: { messageIds: string[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    if (messageIds.length === 0) {
      return { messages: [] };
    }
    const result = await this.database.query<MessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE ${appendInPredicate('id', [], messageIds)}`,
      messageIds
    );
    const byId = new Map(result.rows.map((row) => [row.id, messageFromRow(row)]));
    return { messages: messageIds.flatMap((id) => byId.get(id) ?? []) };
  }

  override async saveMessages(args: { messages: MastraDBMessage[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    if (args.messages.length === 0) {
      return { messages: [] };
    }

    const insertValues: TursoMastraQueryValue[] = [];
    const insertRows = args.messages.map((message) => {
      insertValues.push(
        message.id,
        message.threadId ?? '',
        JSON.stringify(message.content),
        message.role,
        message.type ?? 'v2',
        toSqlDate(message.createdAt),
        message.resourceId ?? null
      );
      return '(?, ?, ?, ?, ?, ?, ?)';
    });

    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.messages}
        (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ${insertRows.join(', ')}
       ON CONFLICT (id) DO UPDATE SET
        thread_id = EXCLUDED.thread_id,
        content = EXCLUDED.content,
        role = EXCLUDED.role,
        type = EXCLUDED.type,
        "createdAt" = EXCLUDED."createdAt",
        "resourceId" = EXCLUDED."resourceId"`,
      insertValues
    );

    const threadUpdates = new Map<string, Date>();
    for (const message of args.messages) {
      if (!message.threadId) {
        continue;
      }
      const currentUpdatedAt = threadUpdates.get(message.threadId);
      if (!(currentUpdatedAt && currentUpdatedAt.getTime() >= message.createdAt.getTime())) {
        threadUpdates.set(message.threadId, message.createdAt);
      }
    }
    if (threadUpdates.size > 0) {
      for (const [threadId, updatedAt] of threadUpdates) {
        const updatedAtSql = toSqlDate(updatedAt);
        await this.database.query(
          `UPDATE ${MASTRA_MEMORY_TABLES.threads}
           SET "updatedAt" = CASE WHEN "updatedAt" > ? THEN "updatedAt" ELSE ? END
           WHERE id = ?`,
          [updatedAtSql, updatedAtSql, threadId]
        );
      }
    }

    return { messages: args.messages };
  }

  override async updateMessages(args: {
    messages: (Partial<Omit<MastraDBMessage, 'createdAt'>> & {
      content?: {
        content?: MastraMessageContentV2['content'];
        metadata?: MastraMessageContentV2['metadata'];
      };
      id: string;
    })[];
  }): Promise<MastraDBMessage[]> {
    const messageIds = args.messages.map((message) => message.id);
    const existing = await this.listMessagesById({ messageIds });
    const existingById = new Map(existing.messages.map((message) => [message.id, message]));
    const mergedMessages: MastraDBMessage[] = [];

    for (const message of args.messages) {
      const current = existingById.get(message.id);
      if (!current) {
        continue;
      }
      mergedMessages.push({
        ...current,
        ...message,
        content:
          message.content === undefined
            ? current.content
            : {
                ...current.content,
                ...message.content,
              },
      } as MastraDBMessage);
    }

    if (mergedMessages.length > 0) {
      await this.saveMessages({ messages: mergedMessages });
    }

    return (await this.listMessagesById({ messageIds })).messages;
  }

  override async deleteMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    await this.database.query(
      `DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE ${appendInPredicate('id', [], messageIds)}`,
      messageIds
    );
  }

  override async getResourceById({
    resourceId,
  }: {
    resourceId: string;
  }): Promise<StorageResourceType | null> {
    const result = await this.database.query<ResourceRow>(
      `SELECT id, "workingMemory", metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.resources}
       WHERE id = ?`,
      [resourceId]
    );
    const row = result.rows[0];
    const resource = row ? resourceFromRow(row) : null;
    const workingMemoryChars = resource?.workingMemory?.length ?? 0;
    this.emitRunEvent(
      'memory.working.loaded',
      'completed',
      'Working memory loaded',
      {
        exists: resource !== null,
        resourceId,
        workingMemoryChars,
      },
      workingMemoryChars > 0 ? `${workingMemoryChars} chars` : 'empty'
    );
    return resource;
  }

  override async saveResource({
    resource,
  }: {
    resource: StorageResourceType;
  }): Promise<StorageResourceType> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.resources}
        (id, "workingMemory", metadata, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
        "workingMemory" = EXCLUDED."workingMemory",
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        resource.id,
        resource.workingMemory ?? null,
        toJsonString(resource.metadata),
        toSqlDate(resource.createdAt),
        toSqlDate(resource.updatedAt),
      ]
    );
    const saved = await this.getResourceById({ resourceId: resource.id });
    if (!saved) {
      throw new Error(`Failed to save Mastra resource: ${resource.id}`);
    }
    return saved;
  }

  override async updateResource({
    resourceId,
    workingMemory,
    metadata,
  }: {
    metadata?: Record<string, unknown>;
    resourceId: string;
    workingMemory?: string;
  }): Promise<StorageResourceType> {
    const existing = await this.getResourceById({ resourceId });
    const now = new Date();
    const next: StorageResourceType = {
      id: resourceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (workingMemory === undefined) {
      if (existing?.workingMemory !== undefined) {
        next.workingMemory = existing.workingMemory;
      }
    } else {
      next.workingMemory = workingMemory;
    }
    if (metadata === undefined) {
      if (existing?.metadata !== undefined) {
        next.metadata = existing.metadata;
      }
    } else {
      next.metadata = metadata;
    }
    const saved = await this.saveResource({ resource: next });
    const savedWorkingMemoryChars = saved.workingMemory?.length ?? 0;
    this.emitRunEvent(
      'memory.working.updated',
      'completed',
      'Working memory updated',
      {
        hasWorkingMemory: saved.workingMemory !== undefined,
        resourceId,
        workingMemoryChars: savedWorkingMemoryChars,
      },
      savedWorkingMemoryChars > 0 ? `${savedWorkingMemoryChars} chars` : 'cleared'
    );
    return saved;
  }

  override async getObservationalMemory(
    threadId: string | null,
    resourceId: string
  ): Promise<ObservationalMemoryRecord | null> {
    const result = await this.database.query<ObservationalMemoryRow>(
      `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE "lookupKey" = ?
       ORDER BY "generationCount" DESC, "createdAt" DESC
       LIMIT 1`,
      [observationalMemoryKey(threadId, resourceId)]
    );
    const row = result.rows[0];
    const record = row ? observationalMemoryFromRow(row) : null;
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Observational memory read',
      {
        exists: record !== null,
        resourceId,
        scope: threadId ? 'thread' : 'resource',
        ...(record
          ? {
              generationCount: record.generationCount,
              observationChars: record.activeObservations.length,
              observationTokens: record.observationTokenCount,
            }
          : {}),
      },
      record
        ? `generation ${record.generationCount} · ${record.observationTokenCount} observation tokens`
        : 'no observations yet'
    );
    return record;
  }

  override async getObservationalMemoryHistory(
    threadId: string | null,
    resourceId: string,
    limit?: number,
    options?: ObservationalMemoryHistoryOptions
  ): Promise<ObservationalMemoryRecord[]> {
    const values: TursoMastraQueryValue[] = [observationalMemoryKey(threadId, resourceId)];
    const where = ['"lookupKey" = ?'];
    if (options?.from) {
      values.push(toSqlDate(options.from));
      where.push('"createdAt" >= ?');
    }
    if (options?.to) {
      values.push(toSqlDate(options.to));
      where.push('"createdAt" <= ?');
    }
    let sql = `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE ${where.join(' AND ')}
       ORDER BY "generationCount" DESC, "createdAt" DESC`;
    if (limit !== undefined) {
      values.push(limit);
      sql = `${sql} LIMIT ?`;
    }
    if (options?.offset !== undefined) {
      values.push(options.offset);
      sql = limit === undefined ? `${sql} LIMIT -1 OFFSET ?` : `${sql} OFFSET ?`;
    }
    const result = await this.database.query<ObservationalMemoryRow>(sql, values);
    const records = result.rows.map(observationalMemoryFromRow);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Observation history loaded',
      {
        count: records.length,
        resourceId,
        scope: threadId ? 'thread' : 'resource',
      },
      formatCountDetail(records.length, 'record')
    );
    return records;
  }

  override async initializeObservationalMemory(
    input: CreateObservationalMemoryInput
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      id: crypto.randomUUID(),
      scope: input.scope,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: now,
      updatedAt: now,
      originType: 'initial',
      generationCount: 0,
      activeObservations: '',
      totalTokensObserved: 0,
      observationTokenCount: 0,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      config: input.config,
      metadata: {},
    };
    if (input.observedTimezone) {
      record.observedTimezone = input.observedTimezone;
    }
    await this.insertObservationalMemoryRecord(record);
    this.emitRunEvent(
      'memory.configured',
      'completed',
      'Observational memory configured',
      {
        resourceId: input.resourceId,
        scope: input.scope,
      },
      `${input.scope} scope`
    );
    return record;
  }

  override async insertObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    await this.saveObservationalMemoryRecord(record);
  }

  override async updateActiveObservations(input: UpdateActiveObservationsInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.activeObservations = input.observations;
    record.observationTokenCount = input.tokenCount;
    record.totalTokensObserved += input.tokenCount;
    record.pendingMessageTokens = 0;
    record.lastObservedAt = input.lastObservedAt;
    record.updatedAt = new Date();
    if (input.observedMessageIds) {
      record.observedMessageIds = input.observedMessageIds;
    }
    if (input.observedTimezone) {
      record.observedTimezone = input.observedTimezone;
    }
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent('memory.observation.completed', 'completed', 'Observations updated', {
      messageCount: input.observedMessageIds?.length ?? 0,
      tokenCount: input.tokenCount,
    });
  }

  override async updateBufferedObservations(input: UpdateBufferedObservationsInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    const chunk = {
      ...input.chunk,
      id: `ombuf-${crypto.randomUUID()}`,
      createdAt: new Date(),
    };
    record.bufferedObservationChunks = [...(record.bufferedObservationChunks ?? []), chunk];
    if (input.lastBufferedAtTime) {
      record.lastBufferedAtTime = input.lastBufferedAtTime;
    }
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Buffered observations updated',
      {
        messageCount: input.chunk.messageIds.length,
        tokenCount: input.chunk.tokenCount,
      }
    );
  }

  override async swapBufferedToActive(
    input: SwapBufferedToActiveInput
  ): Promise<SwapBufferedToActiveResult> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    const chunks = input.bufferedChunks ?? record.bufferedObservationChunks ?? [];
    if (chunks.length === 0) {
      return emptyBufferedActivation();
    }

    const chunksToActivate = chooseBufferedActivationCount(chunks, input).count;
    const activatedChunks = chunks.slice(0, chunksToActivate);
    const remainingChunks = chunks.slice(chunksToActivate);
    const activatedContent = activatedChunks.map((chunk) => chunk.observations).join('\n\n');
    const activatedTokens = activatedChunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
    const activatedMessageTokens = activatedChunks.reduce(
      (sum, chunk) => sum + chunk.messageTokens,
      0
    );
    const activatedMessageCount = activatedChunks.reduce(
      (sum, chunk) => sum + chunk.messageIds.length,
      0
    );
    const latestChunk = activatedChunks.at(-1);
    const derivedLastObservedAt = input.lastObservedAt ?? latestChunk?.lastObservedAt ?? new Date();

    if (record.activeObservations) {
      const boundary = `\n\n--- message boundary (${derivedLastObservedAt.toISOString()}) ---\n\n`;
      record.activeObservations = `${record.activeObservations}${boundary}${activatedContent}`;
    } else {
      record.activeObservations = activatedContent;
    }
    record.observationTokenCount += activatedTokens;
    record.pendingMessageTokens = Math.max(0, record.pendingMessageTokens - activatedMessageTokens);
    const recordToSave =
      remainingChunks.length > 0
        ? { ...record, bufferedObservationChunks: remainingChunks }
        : withoutBufferedObservationChunks(record);
    record.lastObservedAt = derivedLastObservedAt;
    record.updatedAt = new Date();
    recordToSave.lastObservedAt = derivedLastObservedAt;
    recordToSave.updatedAt = record.updatedAt;
    await this.saveObservationalMemoryRecord(recordToSave);
    this.emitRunEvent(
      'memory.observation.completed',
      'completed',
      'Buffered observations activated',
      {
        chunksActivated: activatedChunks.length,
        messagesActivated: activatedMessageCount,
        tokenCount: activatedTokens,
      }
    );

    return {
      chunksActivated: activatedChunks.length,
      messageTokensActivated: activatedMessageTokens,
      observationTokensActivated: activatedTokens,
      messagesActivated: activatedMessageCount,
      activatedCycleIds: activatedChunks.map((chunk) => chunk.cycleId).filter(Boolean),
      activatedMessageIds: activatedChunks.flatMap((chunk) => chunk.messageIds),
      observations: activatedContent,
      perChunk: activatedChunks.map((chunk) => ({
        cycleId: chunk.cycleId,
        messageTokens: chunk.messageTokens,
        observationTokens: chunk.tokenCount,
        messageCount: chunk.messageIds.length,
        observations: chunk.observations,
      })),
      ...(latestChunk?.suggestedContinuation
        ? { suggestedContinuation: latestChunk.suggestedContinuation }
        : {}),
      ...(latestChunk?.currentTask ? { currentTask: latestChunk.currentTask } : {}),
    };
  }

  override async createReflectionGeneration(
    input: CreateReflectionGenerationInput
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      id: crypto.randomUUID(),
      scope: input.currentRecord.scope,
      threadId: input.currentRecord.threadId,
      resourceId: input.currentRecord.resourceId,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: input.currentRecord.lastObservedAt ?? now,
      originType: 'reflection',
      generationCount: input.currentRecord.generationCount + 1,
      activeObservations: input.reflection,
      config: input.currentRecord.config,
      totalTokensObserved: input.currentRecord.totalTokensObserved,
      observationTokenCount: input.tokenCount,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      metadata: {},
    };
    if (input.currentRecord.observedTimezone) {
      record.observedTimezone = input.currentRecord.observedTimezone;
    }
    await this.insertObservationalMemoryRecord(record);
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Memory reflection created', {
      generationCount: record.generationCount,
      tokenCount: input.tokenCount,
    });
    return record;
  }

  override async updateBufferedReflection(input: UpdateBufferedReflectionInput): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.bufferedReflection = record.bufferedReflection
      ? `${record.bufferedReflection}\n\n${input.reflection}`
      : input.reflection;
    record.bufferedReflectionTokens = (record.bufferedReflectionTokens ?? 0) + input.tokenCount;
    record.bufferedReflectionInputTokens =
      (record.bufferedReflectionInputTokens ?? 0) + input.inputTokenCount;
    record.reflectedObservationLineCount = input.reflectedObservationLineCount;
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Buffered reflection updated', {
      inputTokenCount: input.inputTokenCount,
      tokenCount: input.tokenCount,
    });
  }

  override async swapBufferedReflectionToActive(
    input: SwapBufferedReflectionToActiveInput
  ): Promise<ObservationalMemoryRecord> {
    const record = await this.findObservationalMemoryRecordById(input.currentRecord.id);
    if (!record.bufferedReflection) {
      throw new Error('No buffered reflection to swap');
    }
    const reflectedLineCount = record.reflectedObservationLineCount ?? 0;
    const unreflectedContent = record.activeObservations
      .split('\n')
      .slice(reflectedLineCount)
      .join('\n')
      .trim();
    const nextObservations = unreflectedContent
      ? `${record.bufferedReflection}\n\n${unreflectedContent}`
      : record.bufferedReflection;
    const generation = await this.createReflectionGeneration({
      currentRecord: record,
      reflection: nextObservations,
      tokenCount: input.tokenCount,
    });
    await this.saveObservationalMemoryRecord(withoutBufferedReflection(record));
    this.emitRunEvent('memory.reflection.completed', 'completed', 'Buffered reflection activated', {
      generationCount: generation.generationCount,
      tokenCount: input.tokenCount,
    });
    return generation;
  }

  override async setReflectingFlag(id: string, isReflecting: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isReflecting"', isReflecting]]);
    if (isReflecting) {
      this.emitRunEvent('memory.reflection.started', 'running', 'Memory reflection started');
    }
  }

  override async setObservingFlag(id: string, isObserving: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isObserving"', isObserving]]);
    if (isObserving) {
      this.emitRunEvent('memory.observation.started', 'running', 'Memory observation started');
    }
  }

  override async setBufferingObservationFlag(
    id: string,
    isBuffering: boolean,
    lastBufferedAtTokens?: number
  ): Promise<void> {
    const updates: [string, TursoMastraQueryValue][] = [['"isBufferingObservation"', isBuffering]];
    if (lastBufferedAtTokens !== undefined) {
      updates.push(['"lastBufferedAtTokens"', lastBufferedAtTokens]);
    }
    await this.updateObservationalMemoryColumns(id, updates);
  }

  override async setBufferingReflectionFlag(id: string, isBuffering: boolean): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"isBufferingReflection"', isBuffering]]);
    if (isBuffering) {
      this.emitRunEvent('memory.reflection.started', 'running', 'Buffered reflection started');
    }
  }

  override async clearObservationalMemory(
    threadId: string | null,
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `DELETE FROM ${MASTRA_MEMORY_TABLES.observationalMemory} WHERE "lookupKey" = ?`,
      [observationalMemoryKey(threadId, resourceId)]
    );
  }

  override async setPendingMessageTokens(id: string, tokenCount: number): Promise<void> {
    await this.updateObservationalMemoryColumns(id, [['"pendingMessageTokens"', tokenCount]]);
  }

  override async updateObservationalMemoryConfig(
    input: UpdateObservationalMemoryConfigInput
  ): Promise<void> {
    const record = await this.findObservationalMemoryRecordById(input.id);
    record.config = this.deepMergeConfig(record.config, input.config);
    record.updatedAt = new Date();
    await this.saveObservationalMemoryRecord(record);
  }

  private async listMessagesWhere(args: MessageListArgs): Promise<StorageListMessagesOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_MESSAGES_PER_PAGE);
    const where: string[] = [];
    const values: TursoMastraQueryValue[] = [];

    if (args.threadIds) {
      where.push(appendInPredicate('thread_id', values, args.threadIds));
    }
    if (args.resourceId !== undefined) {
      values.push(args.resourceId);
      where.push('"resourceId" = ?');
    }
    const dateRange = args.filter?.dateRange;
    if (dateRange?.start) {
      values.push(toSqlDate(dateRange.start));
      where.push(`"createdAt" ${dateRange.startExclusive ? '>' : '>='} ?`);
    }
    if (dateRange?.end) {
      values.push(toSqlDate(dateRange.end));
      where.push(`"createdAt" ${dateRange.endExclusive ? '<' : '<='} ?`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this.database.query<CountRow>(
      `SELECT COUNT(*) AS count FROM ${MASTRA_MEMORY_TABLES.messages} ${whereSql}`,
      values
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const queryValues = [...values];
    const baseSql = `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       ${whereSql}
       ORDER BY ${orderBySql(args.orderBy, 'createdAt', 'DESC')}`;
    const result = await this.database.query<MessageRow>(
      appendLimit(baseSql, queryValues, page, perPage),
      queryValues
    );
    const messages = result.rows.map(messageFromRow);
    if (args.include?.length) {
      const messageIds = new Set(messages.map((message) => message.id));
      await this.appendIncludedMessages(messages, messageIds, args.include, args);
      const messageOrder = normalizeMessageOrder(args.orderBy);
      messages.sort((left, right) => compareMessagesByOrder(left, right, messageOrder));
    }
    const pageInfo = pagination(total, page, perPage);
    const hasMore = args.include?.length
      ? new Set(
          messages
            .filter((message) => messageMatchesListFilters(message, args))
            .map((message) => message.id)
        ).size < total
      : pageInfo.hasMore;
    return {
      messages,
      ...pageInfo,
      hasMore,
    };
  }

  private async appendIncludedMessages(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    includeItems: MessageIncludeItem[],
    args: MessageListArgs
  ): Promise<void> {
    for (const includeItem of includeItems) {
      if (!includeItem.id.trim()) {
        throw new Error('include.id must be a non-empty string');
      }

      const targetRow = await this.findMessageRowById(includeItem.id);
      if (!targetRow) {
        continue;
      }
      if (!messageRowMatchesListScope(targetRow, args)) {
        continue;
      }

      this.appendMessageIfMissing(messages, messageIds, targetRow);

      const withPreviousMessages = normalizeIncludeWindowCount(
        includeItem.withPreviousMessages,
        'include.withPreviousMessages'
      );
      const withNextMessages = normalizeIncludeWindowCount(
        includeItem.withNextMessages,
        'include.withNextMessages'
      );
      if (withPreviousMessages === 0 && withNextMessages === 0) {
        continue;
      }

      const threadId = normalizeIncludeThreadId(includeItem.threadId, targetRow.threadId);
      if (threadId !== targetRow.threadId) {
        continue;
      }

      const previousRows = await this.listAdjacentThreadMessageRows(
        targetRow,
        'previous',
        withPreviousMessages
      );
      for (const row of previousRows) {
        this.appendMessageIfInListScope(messages, messageIds, row, args);
      }

      const nextRows = await this.listAdjacentThreadMessageRows(
        targetRow,
        'next',
        withNextMessages
      );
      for (const row of nextRows) {
        this.appendMessageIfInListScope(messages, messageIds, row, args);
      }
    }
  }

  private appendMessageIfInListScope(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    row: MessageRow,
    args: MessageListArgs
  ): void {
    if (!messageRowMatchesListScope(row, args)) {
      return;
    }
    this.appendMessageIfMissing(messages, messageIds, row);
  }

  private appendMessageIfMissing(
    messages: MastraDBMessage[],
    messageIds: Set<string>,
    row: MessageRow
  ): void {
    if (messageIds.has(row.id)) {
      return;
    }
    messages.push(messageFromRow(row));
    messageIds.add(row.id);
  }

  private async findMessageRowById(id: string): Promise<MessageRow | null> {
    const result = await this.database.query<MessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE id = ?`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  private async listAdjacentThreadMessageRows(
    targetRow: MessageRow,
    direction: 'previous' | 'next',
    limit: number
  ): Promise<MessageRow[]> {
    if (limit === 0) {
      return [];
    }
    const isPrevious = direction === 'previous';
    const comparisonOperator = isPrevious ? '<' : '>';
    const sortDirection = isPrevious ? 'DESC' : 'ASC';
    const result = await this.database.query<MessageRow>(
      `SELECT id, thread_id AS "threadId", content, role, type, "createdAt", "resourceId"
       FROM ${MASTRA_MEMORY_TABLES.messages}
       WHERE thread_id = ?
         AND (
           "createdAt" ${comparisonOperator} ?
           OR ("createdAt" = ? AND id ${comparisonOperator} ?)
         )
       ORDER BY "createdAt" ${sortDirection}, id ${sortDirection}
       LIMIT ?`,
      [
        targetRow.threadId,
        toSqlDate(targetRow.createdAt),
        toSqlDate(targetRow.createdAt),
        targetRow.id,
        limit,
      ]
    );
    return isPrevious ? [...result.rows].reverse() : result.rows;
  }

  private async findObservationalMemoryRecordById(id: string): Promise<ObservationalMemoryRecord> {
    const result = await this.database.query<ObservationalMemoryRow>(
      `SELECT *
       FROM ${MASTRA_MEMORY_TABLES.observationalMemory}
       WHERE id = ?`,
      [id]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Observational memory record not found: ${id}`);
    }
    return observationalMemoryFromRow(row);
  }

  private async saveObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.observationalMemory}
        (id, "lookupKey", scope, "resourceId", "threadId", "activeObservations",
         "activeObservationsPendingUpdate", "originType", config, "generationCount",
         "lastObservedAt", "lastReflectionAt", "pendingMessageTokens",
         "totalTokensObserved", "observationTokenCount", "isObserving", "isReflecting",
         "observedMessageIds", "observedTimezone", "bufferedObservations",
         "bufferedObservationTokens", "bufferedMessageIds", "bufferedReflection",
         "bufferedReflectionTokens", "bufferedReflectionInputTokens",
         "reflectedObservationLineCount", "bufferedObservationChunks",
         "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens",
         "lastBufferedAtTime", metadata, "createdAt", "updatedAt")
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
        "lookupKey" = EXCLUDED."lookupKey",
        scope = EXCLUDED.scope,
        "resourceId" = EXCLUDED."resourceId",
        "threadId" = EXCLUDED."threadId",
        "activeObservations" = EXCLUDED."activeObservations",
        "activeObservationsPendingUpdate" = EXCLUDED."activeObservationsPendingUpdate",
        "originType" = EXCLUDED."originType",
        config = EXCLUDED.config,
        "generationCount" = EXCLUDED."generationCount",
        "lastObservedAt" = EXCLUDED."lastObservedAt",
        "lastReflectionAt" = EXCLUDED."lastReflectionAt",
        "pendingMessageTokens" = EXCLUDED."pendingMessageTokens",
        "totalTokensObserved" = EXCLUDED."totalTokensObserved",
        "observationTokenCount" = EXCLUDED."observationTokenCount",
        "isObserving" = EXCLUDED."isObserving",
        "isReflecting" = EXCLUDED."isReflecting",
        "observedMessageIds" = EXCLUDED."observedMessageIds",
        "observedTimezone" = EXCLUDED."observedTimezone",
        "bufferedObservations" = EXCLUDED."bufferedObservations",
        "bufferedObservationTokens" = EXCLUDED."bufferedObservationTokens",
        "bufferedMessageIds" = EXCLUDED."bufferedMessageIds",
        "bufferedReflection" = EXCLUDED."bufferedReflection",
        "bufferedReflectionTokens" = EXCLUDED."bufferedReflectionTokens",
        "bufferedReflectionInputTokens" = EXCLUDED."bufferedReflectionInputTokens",
        "reflectedObservationLineCount" = EXCLUDED."reflectedObservationLineCount",
        "bufferedObservationChunks" = EXCLUDED."bufferedObservationChunks",
        "isBufferingObservation" = EXCLUDED."isBufferingObservation",
        "isBufferingReflection" = EXCLUDED."isBufferingReflection",
        "lastBufferedAtTokens" = EXCLUDED."lastBufferedAtTokens",
        "lastBufferedAtTime" = EXCLUDED."lastBufferedAtTime",
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        record.id,
        observationalMemoryKey(record.threadId, record.resourceId),
        record.scope,
        record.resourceId,
        record.threadId,
        record.activeObservations,
        null,
        record.originType,
        JSON.stringify(record.config),
        record.generationCount,
        record.lastObservedAt ? toSqlDate(record.lastObservedAt) : null,
        null,
        record.pendingMessageTokens,
        record.totalTokensObserved,
        record.observationTokenCount,
        toSqlBoolean(record.isObserving),
        toSqlBoolean(record.isReflecting),
        record.observedMessageIds ? JSON.stringify(record.observedMessageIds) : null,
        record.observedTimezone ?? null,
        record.bufferedObservations ?? null,
        record.bufferedObservationTokens ?? null,
        record.bufferedMessageIds ? JSON.stringify(record.bufferedMessageIds) : null,
        record.bufferedReflection ?? null,
        record.bufferedReflectionTokens ?? null,
        record.bufferedReflectionInputTokens ?? null,
        record.reflectedObservationLineCount ?? null,
        record.bufferedObservationChunks ? JSON.stringify(record.bufferedObservationChunks) : null,
        toSqlBoolean(record.isBufferingObservation),
        toSqlBoolean(record.isBufferingReflection),
        record.lastBufferedAtTokens,
        record.lastBufferedAtTime ? toSqlDate(record.lastBufferedAtTime) : null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        toSqlDate(record.createdAt),
        toSqlDate(record.updatedAt),
      ]
    );
  }

  private async updateObservationalMemoryColumns(
    id: string,
    updates: [string, TursoMastraQueryValue][]
  ): Promise<void> {
    const now = new Date();
    const values: TursoMastraQueryValue[] = [];
    const setClauses = updates.map(([column, value]) => {
      values.push(typeof value === 'boolean' ? toSqlBoolean(value) : value);
      return `${column} = ?`;
    });
    values.push(toSqlDate(now), id);
    const result = await this.database.query<{ id: string }>(
      `UPDATE ${MASTRA_MEMORY_TABLES.observationalMemory}
       SET ${setClauses.join(', ')}, "updatedAt" = ?
       WHERE id = ?
       RETURNING id`,
      values
    );
    if (!result.rows[0]) {
      throw new Error(`Observational memory record not found: ${id}`);
    }
  }

  private emitRunEvent(
    kind: AssistantRunEventKind,
    status: AssistantRunEventStatus,
    label: string,
    metadata?: AssistantRunEventMetadata,
    detail?: string
  ): void {
    emitAssistantRunEventSafely({
      event: {
        kind,
        label,
        status,
        ...(metadata ? { metadata } : {}),
        ...(detail ? { detail } : {}),
      },
      eventSink: this.eventSink,
      onError: (error, event) => {
        logger.error('Assistant run event sink failed during memory operation', {
          code: 'assistant_run_event_sink_failed',
          error: getErrorMessage(error),
          kind: event.kind,
          runId: event.runId,
        });
      },
      runId: this.runId,
    });
  }
}

async function runTransaction<T>(
  database: TursoMastraSqlClient,
  operation: (tx: TursoMastraSqlClient) => Promise<T>
): Promise<T> {
  if (typeof database.transaction !== 'function') {
    throw new Error('Turso memory store requires transaction support');
  }
  return database.transaction(operation);
}
