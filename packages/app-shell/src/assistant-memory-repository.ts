import {
  type PgliteDatabase,
  PgliteMemoryStore,
  type PgliteQueryValues,
} from '@brainstrike/agent/pglite-mastra-memory/store';
import type { DbHandle } from '@brainstrike/db';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/ui/assistant-ui-panel';

export interface AssistantMemoryThread {
  readonly createdAt: Date;
  readonly id: string;
  readonly resourceId: string;
  readonly title: string;
  readonly updatedAt: Date;
}

export interface AssistantThreadRepository {
  createThread: (resourceId: string) => Promise<AssistantMemoryThread>;
  deleteThread: (threadId: string) => Promise<void>;
  listMessages: (
    threadId: string,
    resourceId: string
  ) => Promise<readonly AssistantHistoryMessage[]>;
  listThreads: (resourceId: string) => Promise<readonly AssistantMemoryThread[]>;
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

function toPgliteDatabase(
  database: DbHandle & { exec: NonNullable<DbHandle['exec']> }
): PgliteDatabase {
  return {
    exec: (sql: string) => database.exec(sql),
    query: <TRecord extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: PgliteQueryValues
    ) => database.query<TRecord>(sql, values ? [...values] : undefined),
  };
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
  };
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

  const store = new PgliteMemoryStore({ database: toPgliteDatabase(database) });
  let initPromise: Promise<void> | null = null;
  const initialize = async (): Promise<void> => {
    initPromise ??= store.init();
    await initPromise;
  };

  return {
    async createThread(resourceId: string): Promise<AssistantMemoryThread> {
      await initialize();
      const now = new Date();
      const thread = await store.saveThread({
        thread: {
          id: createThreadId(),
          resourceId,
          title: 'New Thread',
          createdAt: now,
          updatedAt: now,
          metadata: { source: 'brainstrike' },
        },
      });
      return toMemoryThread(thread);
    },
    async deleteThread(threadId: string): Promise<void> {
      await initialize();
      await store.deleteThread({ threadId });
    },
    async listMessages(
      threadId: string,
      resourceId: string
    ): Promise<readonly AssistantHistoryMessage[]> {
      await initialize();
      const result = await store.listMessages({
        threadId,
        resourceId,
        perPage: false,
        orderBy: { field: 'createdAt', direction: 'ASC' },
      });
      return result.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: normalizeDate(message.createdAt),
      }));
    },
    async listThreads(resourceId: string): Promise<readonly AssistantMemoryThread[]> {
      await initialize();
      const result = await store.listThreads({
        filter: { resourceId },
        perPage: false,
        orderBy: { field: 'updatedAt', direction: 'DESC' },
      });
      return result.threads.map(toMemoryThread);
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
