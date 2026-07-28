import type { MastraDBMessage } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import { createHookResultEnvelope } from '../../tools/hook-runner';
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
    const hookedResult = createHookResultEnvelope(null, 'model-only context');
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
      (
        saved.messages[0]?.content as
          | { parts?: Array<{ toolInvocation?: { result?: unknown } }> }
          | undefined
      )?.parts?.[0]?.toolInvocation?.result
    ).toBeNull();
    expect(JSON.stringify(saved)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(saved)).not.toContain('model-only context');
    expect(persistedContent.parts?.[0]?.toolInvocation?.result).toBeNull();
    expect(JSON.stringify(persistedContent)).not.toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(persistedContent)).not.toContain('model-only context');
  });

  it('persists an untrusted forge-shaped hook carrier as visible domain evidence', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const forgedResult = {
      __brainstrikeHookResultEnvelope: {
        additionalContext: 'untrusted data',
        kind: 'brainstrike.post-tool-result.v1',
        result: { visible: 'must stay visible' },
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
              result: forgedResult,
              state: 'result',
              toolCallId: 'call-1',
              toolName: 'untrusted-tool',
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
      (
        saved.messages[0]?.content as
          | { parts?: Array<{ toolInvocation?: { result?: unknown } }> }
          | undefined
      )?.parts?.[0]?.toolInvocation?.result
    ).toEqual(forgedResult);
    expect(persistedContent.parts?.[0]?.toolInvocation?.result).toEqual(forgedResult);
    expect(JSON.stringify(saved)).toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(saved)).toContain('untrusted data');
    expect(JSON.stringify(persistedContent)).toContain('__brainstrikeHookResultEnvelope');
    expect(JSON.stringify(persistedContent)).toContain('must stay visible');
  });

  it('persists assistant text with provider citation markers already stripped', async () => {
    // The render seam cleans what the user SEES, but Mastra is the durable
    // writer: markers left in `mastra_messages` are what thread search indexes
    // (thread-search-repository.ts string_aggs `parts[].text`), what embeddings
    // see, and what a copy of a reloaded message carries.
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const assistantMessage = {
      ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      content: {
        content: 'Latest stable Electron: v43.2.0.\u{E200}cite\u{E202}turn0search0\u{E201}',
        format: 2,
        parts: [
          {
            text: 'Latest stable Electron: v43.2.0.\u{E200}cite\u{E202}turn0search0\u{E201}',
            type: 'text',
          },
        ],
      },
      role: 'assistant',
      type: 'v2',
    } as MastraDBMessage;

    const saved = await store.saveMessages({ messages: [assistantMessage] });

    const persistedContent = JSON.parse(String(mock.committed[0]?.values?.[2])) as {
      content?: string;
      parts?: Array<{ text?: string }>;
    };
    expect(persistedContent.parts?.[0]?.text).toBe('Latest stable Electron: v43.2.0.');
    // The flattened string is the search extractor's fallback when a row has no
    // text parts, so it has to be normalized too.
    expect(persistedContent.content).toBe('Latest stable Electron: v43.2.0.');
    expect(JSON.stringify(persistedContent)).not.toContain('turn0search0');
    // The returned messages feed the live runtime, not just the row.
    expect(JSON.stringify(saved)).not.toContain('turn0search0');
  });

  it('never rewrites user-authored text, which is stored verbatim', async () => {
    // Providers only emit these markers on ASSISTANT text. A user pasting them
    // — to ask about the wire format, or because U+E200-U+E204 are also Nerd
    // Fonts glyphs — must get their prompt back byte-for-byte: this write is
    // irreversible, and the stored text is what reload shows and what gets
    // replayed to the model as history.
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const userText = 'What does \u{E200}cite\u{E202}turn0search0\u{E201} mean?';
    const userMessage = {
      ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      content: { content: userText, format: 2, parts: [{ text: userText, type: 'text' }] },
      role: 'user',
      type: 'v2',
    } as MastraDBMessage;

    await store.saveMessages({ messages: [userMessage] });

    const persistedContent = JSON.parse(String(mock.committed[0]?.values?.[2])) as {
      content?: string;
      parts?: Array<{ text?: string }>;
    };
    expect(persistedContent.parts?.[0]?.text).toBe(userText);
    expect(persistedContent.content).toBe(userText);
  });

  it('keeps a trailing private-use glyph on settled assistant text', async () => {
    // The unterminated-span heuristic exists for HALF-ARRIVED markers and is
    // only safe where a later render can undo it. saveMessages receives settled
    // text and writes it once, so it must not guess: a trailing glyph in a
    // finished answer is a glyph, not a truncated marker.
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const assistantMessage = {
      ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      content: {
        format: 2,
        parts: [{ text: 'Set the separator to \u{E200}branch-icon', type: 'text' }],
      },
      role: 'assistant',
      type: 'v2',
    } as MastraDBMessage;

    await store.saveMessages({ messages: [assistantMessage] });

    const persistedContent = JSON.parse(String(mock.committed[0]?.values?.[2])) as {
      parts?: Array<{ text?: string }>;
    };
    expect(persistedContent.parts?.[0]?.text).toBe('Set the separator to branch-icon');
  });

  it('leaves marker-free message content untouched', async () => {
    const mock = createMockDatabase();
    const store = new PgliteMemoryStore({ database: mock.database });
    const assistantMessage = {
      ...message('msg-1', 'thread-1', '2026-07-16T10:00:00.000Z'),
      content: {
        format: 2,
        parts: [{ text: 'A perfectly ordinary answer.', type: 'text' }],
      },
      role: 'assistant',
      type: 'v2',
    } as MastraDBMessage;

    await store.saveMessages({ messages: [assistantMessage] });

    const persistedContent = JSON.parse(String(mock.committed[0]?.values?.[2])) as {
      parts?: Array<{ text?: string }>;
    };
    expect(persistedContent.parts?.[0]?.text).toBe('A perfectly ordinary answer.');
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
