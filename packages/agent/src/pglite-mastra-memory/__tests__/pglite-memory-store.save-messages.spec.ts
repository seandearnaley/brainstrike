import type { MastraDBMessage } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import { PgliteMemoryStore } from '../memory-store';
import type { PgliteDatabase, PgliteQueryResult, PgliteQueryValues } from '../types';

interface RecordedStatement {
  readonly sql: string;
  readonly values: PgliteQueryValues | undefined;
}

interface MockDatabase {
  /** Statements from transactions whose callback resolved. */
  readonly committed: RecordedStatement[];
  readonly database: PgliteDatabase;
  /** Statements issued directly on the connection (outside any transaction). */
  readonly directStatements: RecordedStatement[];
  readonly transactionCount: () => number;
}

function createMockDatabase(options?: { failOn?: (sql: string) => boolean }): MockDatabase {
  const committed: RecordedStatement[] = [];
  const directStatements: RecordedStatement[] = [];
  let transactions = 0;

  const database: PgliteDatabase = {
    exec: () => Promise.resolve(undefined),
    query: <TRecord extends Record<string, unknown>>(
      sql: string,
      values?: PgliteQueryValues
    ): Promise<PgliteQueryResult<TRecord>> => {
      directStatements.push({ sql, values });
      return Promise.resolve({ rows: [] });
    },
    transaction: async <T>(fn: (tx: PgliteDatabase) => Promise<T>): Promise<T> => {
      transactions += 1;
      const pending: RecordedStatement[] = [];
      const tx: PgliteDatabase = {
        exec: () => Promise.resolve(undefined),
        query: <TRecord extends Record<string, unknown>>(
          sql: string,
          values?: PgliteQueryValues
        ): Promise<PgliteQueryResult<TRecord>> => {
          if (options?.failOn?.(sql)) {
            return Promise.reject(new Error(`Simulated failure: ${sql.slice(0, 40)}`));
          }
          pending.push({ sql, values });
          return Promise.resolve({ rows: [] });
        },
      };
      const result = await fn(tx);
      committed.push(...pending);
      return result;
    },
  };

  return {
    committed,
    database,
    directStatements,
    transactionCount: () => transactions,
  };
}

function message(id: string, threadId: string, createdAt: string): MastraDBMessage {
  return {
    content: { content: id },
    createdAt: new Date(createdAt),
    id,
    resourceId: 'resource-1',
    role: 'user',
    threadId,
    type: 'text',
  } as MastraDBMessage;
}

describe('PgliteMemoryStore.saveMessages transactionality', () => {
  it('runs the message upsert and thread updatedAt bump in a single transaction', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });

    const messages = [
      message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      message('msg-2', 'thread-1', '2026-07-16T10:01:00.000Z'),
    ];
    const result = await store.saveMessages({ messages });

    expect(result).toEqual({ messages });
    expect(mock.transactionCount()).toBe(1);
    expect(mock.directStatements).toEqual([]);
    expect(mock.committed).toHaveLength(2);
    expect(mock.committed[0]?.sql).toContain('INSERT INTO mastra_messages');
    expect(mock.committed[0]?.sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(mock.committed[1]?.sql).toContain('UPDATE mastra_threads');
    expect(mock.committed[1]?.sql).toContain('GREATEST');
    // Later createdAt wins for the thread bump.
    expect(mock.committed[1]?.values).toEqual(['thread-1', new Date('2026-07-16T10:01:00.000Z')]);
  });

  it('rolls back the message upsert when the thread updatedAt bump fails', async () => {
    const mock = createMockDatabase({
      failOn: (sql) => sql.includes('UPDATE mastra_threads'),
    });
    const store = new PgliteMemoryStore({ database: mock.database });

    await expect(
      store.saveMessages({
        messages: [message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z')],
      })
    ).rejects.toThrow('Simulated failure');

    // Nothing committed: the upsert must not survive the failed thread bump.
    expect(mock.committed).toEqual([]);
    expect(mock.directStatements).toEqual([]);
  });

  it('skips the thread bump statement for messages without a threadId but stays transactional', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });

    const orphan = { ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'), threadId: null };
    await store.saveMessages({ messages: [orphan as unknown as MastraDBMessage] });

    expect(mock.transactionCount()).toBe(1);
    expect(mock.committed).toHaveLength(1);
    expect(mock.committed[0]?.sql).toContain('INSERT INTO mastra_messages');
  });

  it('does not touch the database for an empty message list', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });

    await expect(store.saveMessages({ messages: [] })).resolves.toEqual({ messages: [] });

    expect(mock.transactionCount()).toBe(0);
    expect(mock.directStatements).toEqual([]);
  });

  it('never persists an internal hook carrier when the exact domain result is null', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const hookedResult = {
      __brainstrikeHookResultEnvelope: {
        additionalContext: 'model-only context',
        kind: 'brainstrike.post-tool-result.v1',
        result: null,
      },
    };
    const assistantMessage = {
      ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      content: {
        format: 2,
        parts: [
          {
            toolInvocation: {
              args: {},
              result: hookedResult,
              state: 'result',
              toolCallId: 'call-1',
              toolName: 'nullable-tool',
            },
            type: 'tool-invocation',
          },
        ],
      },
      role: 'assistant',
      type: 'v2',
    } as MastraDBMessage;

    const saved = await store.saveMessages({ messages: [assistantMessage] });

    const persistedContent = JSON.parse(String(mock.committed[0]?.values?.[2])) as {
      parts?: Array<{ toolInvocation?: { result?: unknown } }>;
    };
    expect(
      (saved.messages[0]?.content as { parts?: Array<{ toolInvocation?: { result?: unknown } }> })
        .parts?.[0]?.toolInvocation?.result
    ).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(saved)).not.toContain('model-only context');
    expect(persistedContent.parts?.[0]?.toolInvocation?.result).toBeNull();
    expect(JSON.stringify(persistedContent)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(persistedContent)).not.toContain('model-only context');
  });

  it('throws when the database lacks transaction support (no silent fallback)', async () => {
    const mock = createMockDatabase();
    const { transaction: _transaction, ...withoutTransaction } = mock.database;
    const store = new PgliteMemoryStore({ database: withoutTransaction });

    await expect(
      store.saveMessages({
        messages: [message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z')],
      })
    ).rejects.toThrow('PGlite memory store requires transaction support');

    expect(mock.directStatements).toEqual([]);
  });
});
