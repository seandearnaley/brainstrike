import {
  MASTRA_MEMORY_SCHEMA_SQL,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/agent/pglite-mastra-memory/schema';
import type { DbHandle } from '@brainstrike/db';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/ui/assistant-ui-panel';

export interface AssistantMemoryThread {
  readonly createdAt: Date;
  readonly id: string;
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

export interface AssistantThreadRepository {
  createThread: (resourceId: string) => Promise<AssistantMemoryThread>;
  deleteThread: (threadId: string) => Promise<void>;
  listMessages: (
    threadId: string,
    resourceId: string
  ) => Promise<readonly AssistantHistoryMessage[]>;
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
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return new Date();
}

function toMemoryThread(thread: {
  createdAt: unknown;
  id: string;
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

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
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
  return extractText(content);
}

function toHistoryRepository(
  messages: readonly AssistantHistoryMessage[]
): Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>> {
  const repositoryMessages: Awaited<
    ReturnType<AssistantUiThreadHistoryAdapter['load']>
  >['messages'] = [];
  let parentId: string | null = null;

  for (const message of messages) {
    if (!(message.role === 'user' || message.role === 'assistant' || message.role === 'system')) {
      continue;
    }

    const text = extractText(message.content).trim();
    if (!text) {
      continue;
    }

    const content = [{ type: 'text' as const, text }] as const;
    if (message.role === 'assistant') {
      repositoryMessages.push({
        parentId,
        message: {
          id: message.id,
          role: 'assistant',
          content,
          createdAt: message.createdAt,
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
    } else if (message.role === 'user') {
      repositoryMessages.push({
        parentId,
        message: {
          id: message.id,
          role: 'user',
          content,
          createdAt: message.createdAt,
          attachments: [],
          metadata: { custom: {} },
        },
      });
    } else {
      repositoryMessages.push({
        parentId,
        message: {
          id: message.id,
          role: 'system',
          content,
          createdAt: message.createdAt,
          metadata: { custom: {} },
        },
      });
    }
    parentId = message.id;
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

  let initPromise: Promise<void> | null = null;
  const initialize = async (): Promise<void> => {
    initPromise ??= database.exec(MASTRA_MEMORY_SCHEMA_SQL).then(() => undefined);
    await initPromise;
  };

  return {
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
    async deleteThread(threadId: string): Promise<void> {
      await initialize();
      await database.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.messages} WHERE thread_id = $1`, [
        threadId,
      ]);
      await database.query(`DELETE FROM ${MASTRA_MEMORY_TABLES.threads} WHERE id = $1`, [threadId]);
    },
    async listMessages(
      threadId: string,
      resourceId: string
    ): Promise<readonly AssistantHistoryMessage[]> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT id, role, content, "createdAt"
         FROM ${MASTRA_MEMORY_TABLES.messages}
         WHERE thread_id = $1 AND "resourceId" = $2
         ORDER BY "createdAt" ASC, id ASC`,
        [threadId, resourceId]
      );
      return result.rows.map((row) => ({
        id: requireString(row['id'], 'id'),
        role: requireString(row['role'], 'role'),
        content: parseJson(row['content']),
        createdAt: normalizeDate(row['createdAt']),
      }));
    },
    async listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]> {
      await initialize();
      const result = await database.query<Record<string, unknown>>(
        `SELECT id, "resourceId", title, metadata, "createdAt", "updatedAt"
         FROM ${MASTRA_MEMORY_TABLES.threads}
         WHERE "resourceId" = $1
         ORDER BY "updatedAt" DESC, id DESC`,
        [resourceId]
      );
      return result.rows.map((row) =>
        toMemoryThread({
          id: requireString(row['id'], 'id'),
          resourceId: requireString(row['resourceId'], 'resourceId'),
          title: typeof row['title'] === 'string' ? row['title'] : null,
          metadata: parseJson(row['metadata']),
          createdAt: row['createdAt'],
          updatedAt: row['updatedAt'],
        })
      );
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
      const messages = await repository.listMessages(threadId, resourceId);
      return toHistoryRepository(messages);
    },
    async append() {
      // Mastra is the durable writer for assistant conversations. The client adapter is read-through
      // only to avoid duplicate message rows with client-generated IDs.
    },
  };
}
