import type { MastraMessageContentV2 } from '@mastra/core/agent';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import type {
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  StorageListMessagesOutput,
  StorageListThreadsInput,
  StorageListThreadsOutput,
  StorageResourceType,
  ThreadOrderBy,
  ThreadSortDirection,
} from '@mastra/core/storage';
import { MemoryStorage } from '@mastra/core/storage';
import { MASTRA_MEMORY_SCHEMA_SQL, MASTRA_MEMORY_TABLES } from './sql';
import type { PgliteDatabase, PgliteQueryValue } from './types';

interface PgliteMemoryStoreOptions {
  database: PgliteDatabase;
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
  content: string;
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

const DEFAULT_THREADS_PER_PAGE = 100;
const DEFAULT_MESSAGES_PER_PAGE = 40;
const THREAD_ORDER_FIELDS = new Set<ThreadOrderBy>(['createdAt', 'updatedAt']);
const THREAD_ORDER_DIRECTIONS = new Set<ThreadSortDirection>(['ASC', 'DESC']);

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
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

function parseMessageContent(value: string): MastraDBMessage['content'] {
  const parsed: unknown = JSON.parse(value);
  return parsed as MastraDBMessage['content'];
}

function normalizePerPage(value: number | false | undefined, fallback: number): number | false {
  if (value === false) {
    return false;
  }
  if (value === undefined) {
    return fallback;
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

function appendLimit(
  sql: string,
  values: PgliteQueryValue[],
  page: number,
  perPage: number | false
): string {
  if (perPage === false) {
    return sql;
  }
  values.push(perPage, page * perPage);
  const limitIndex = values.length - 1;
  const offsetIndex = values.length;
  return `${sql} LIMIT $${limitIndex} OFFSET $${offsetIndex}`;
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
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
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

export class PgliteMemoryStore extends MemoryStorage {
  override readonly supportsObservationalMemory = true;
  private readonly database: PgliteDatabase;

  constructor(options: PgliteMemoryStoreOptions) {
    super();
    this.database = options.database;
  }

  override async init(): Promise<void> {
    await this.initialize();
  }

  async initialize(): Promise<void> {
    await this.database.exec(MASTRA_MEMORY_SCHEMA_SQL);
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
  }: {
    threadId: string;
  }): Promise<StorageThreadType | null> {
    const result = await this.database.query<ThreadRow>(
      `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
       FROM ${MASTRA_MEMORY_TABLES.threads}
       WHERE id = $1`,
      [threadId]
    );
    const row = result.rows[0];
    return row ? threadFromRow(row) : null;
  }

  override async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
        (id, "resourceId", title, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
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
        thread.createdAt,
        thread.updatedAt,
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
       SET title = $2, metadata = $3::jsonb, "updatedAt" = $4
       WHERE id = $1`,
      [id, title, toJsonString(metadata), now]
    );
    const updated = await this.getThreadById({ threadId: id });
    if (!updated) {
      throw new Error(`Mastra thread not found: ${id}`);
    }
    return updated;
  }

  override async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    await this.database.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE thread_id = $1`, [
      threadId,
    ]);
    await this.database.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.threads} WHERE id = $1`, [
      threadId,
    ]);
  }

  override async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_THREADS_PER_PAGE);
    const where: string[] = [];
    const values: PgliteQueryValue[] = [];
    const filter = args.filter;

    if (filter?.resourceId) {
      values.push(filter.resourceId);
      where.push(`"resourceId" = $${values.length}`);
    }
    if (filter?.metadata && Object.keys(filter.metadata).length > 0) {
      values.push(JSON.stringify(filter.metadata));
      where.push(`metadata @> $${values.length}::jsonb`);
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
    return this.listMessagesWhere({ ...args, threadIds });
  }

  override async listMessagesByResourceId(
    args: StorageListMessagesByResourceIdInput
  ): Promise<StorageListMessagesOutput> {
    return this.listMessagesWhere(args);
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
       WHERE id = ANY($1::text[])`,
      [messageIds]
    );
    const byId = new Map(result.rows.map((row) => [row.id, messageFromRow(row)]));
    return { messages: messageIds.flatMap((id) => byId.get(id) ?? []) };
  }

  override async saveMessages(args: { messages: MastraDBMessage[] }): Promise<{
    messages: MastraDBMessage[];
  }> {
    for (const message of args.messages) {
      await this.database.query(
        `INSERT INTO ${MASTRA_MEMORY_TABLES.messages}
          (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          content = EXCLUDED.content,
          role = EXCLUDED.role,
          type = EXCLUDED.type,
          "createdAt" = EXCLUDED."createdAt",
          "resourceId" = EXCLUDED."resourceId"`,
        [
          message.id,
          message.threadId ?? '',
          JSON.stringify(message.content),
          message.role,
          message.type ?? 'v2',
          message.createdAt,
          message.resourceId ?? null,
        ]
      );
      if (message.threadId) {
        await this.database.query(
          `UPDATE ${MASTRA_MEMORY_TABLES.threads}
           SET "updatedAt" = GREATEST("updatedAt", $2)
           WHERE id = $1`,
          [message.threadId, message.createdAt]
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
    for (const message of args.messages) {
      const existing = await this.listMessagesById({ messageIds: [message.id] });
      const current = existing.messages[0];
      if (!current) {
        continue;
      }
      const merged: MastraDBMessage = {
        ...current,
        ...message,
        content:
          message.content === undefined
            ? current.content
            : {
                ...current.content,
                ...message.content,
              },
      } as MastraDBMessage;
      await this.saveMessages({ messages: [merged] });
    }
    return (await this.listMessagesById({ messageIds: args.messages.map((message) => message.id) }))
      .messages;
  }

  override async deleteMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    await this.database.query(
      `DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE id = ANY($1::text[])`,
      [messageIds]
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
       WHERE id = $1`,
      [resourceId]
    );
    const row = result.rows[0];
    return row ? resourceFromRow(row) : null;
  }

  override async saveResource({
    resource,
  }: {
    resource: StorageResourceType;
  }): Promise<StorageResourceType> {
    await this.database.query(
      `INSERT INTO ${MASTRA_MEMORY_TABLES.resources}
        (id, "workingMemory", metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
        "workingMemory" = EXCLUDED."workingMemory",
        metadata = EXCLUDED.metadata,
        "createdAt" = EXCLUDED."createdAt",
        "updatedAt" = EXCLUDED."updatedAt"`,
      [
        resource.id,
        resource.workingMemory ?? null,
        toJsonString(resource.metadata),
        resource.createdAt,
        resource.updatedAt,
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
    return this.saveResource({ resource: next });
  }

  private async listMessagesWhere(
    args: (StorageListMessagesInput | StorageListMessagesByResourceIdInput) & {
      threadIds?: string[];
    }
  ): Promise<StorageListMessagesOutput> {
    const page = normalizePage(args.page);
    const perPage = normalizePerPage(args.perPage, DEFAULT_MESSAGES_PER_PAGE);
    const where: string[] = [];
    const values: PgliteQueryValue[] = [];

    if (args.threadIds) {
      values.push(args.threadIds);
      where.push(`thread_id = ANY($${values.length}::text[])`);
    }
    if (args.resourceId) {
      values.push(args.resourceId);
      where.push(`"resourceId" = $${values.length}`);
    }
    const dateRange = args.filter?.dateRange;
    if (dateRange?.start) {
      values.push(dateRange.start);
      where.push(`"createdAt" ${dateRange.startExclusive ? '>' : '>='} $${values.length}`);
    }
    if (dateRange?.end) {
      values.push(dateRange.end);
      where.push(`"createdAt" ${dateRange.endExclusive ? '<' : '<='} $${values.length}`);
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
    return {
      messages: result.rows.map(messageFromRow),
      ...pagination(total, page, perPage),
    };
  }
}
