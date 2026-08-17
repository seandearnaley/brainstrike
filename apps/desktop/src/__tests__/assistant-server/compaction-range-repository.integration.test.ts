import { CompactionOverlayProcessor } from '@brainstrike/agent';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCompactionRangeLookup,
  recordCompactionRange,
} from '../../assistant-server/compaction-range-repository';

type ProcessInputStepArgs = Parameters<CompactionOverlayProcessor['processInputStep']>[0];
type Message = ProcessInputStepArgs['messages'][number];

describe('compaction range repository', () => {
  let db: PGlite;
  const resetFileReads = vi.fn();
  const resetLoopGuards = vi.fn();
  const databaseProvider = async () => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      await db.query<T>(sql, params ? [...params] : undefined),
    transaction: async <T>(
      callback: (tx: {
        query: <TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ) => Promise<{ rows: TRow[] }>;
      }) => Promise<T>
    ) =>
      await db.transaction(
        async (tx) =>
          await callback({
            query: async <TRow = Record<string, unknown>>(
              sql: string,
              params?: readonly unknown[]
            ) => await tx.query<TRow>(sql, params ? [...params] : undefined),
          })
      ),
  });

  beforeEach(async () => {
    db = new PGlite();
    resetFileReads.mockReset();
    resetLoopGuards.mockReset();
    await db.exec(`
      CREATE TABLE mastra_messages (
        id text PRIMARY KEY,
        thread_id text NOT NULL,
        content jsonb NOT NULL,
        role text NOT NULL,
        type text NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "resourceId" text NOT NULL
      );
      CREATE TABLE brainstrike_assistant_message_tombstones (
        message_id text PRIMARY KEY,
        thread_id text NOT NULL,
        rewind_id text NOT NULL,
        tombstoned_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE brainstrike_assistant_compaction_ranges (
        compaction_message_id text PRIMARY KEY,
        thread_id text NOT NULL,
        compacted_message_ids jsonb NOT NULL,
        kind text NOT NULL CHECK (kind IN ('agentic', 'deterministic')),
        created_at timestamptz NOT NULL DEFAULT NOW()
      );
    `);
  });

  afterEach(async () => db.close());

  async function insertMessage(id: string, role: 'assistant' | 'user', minute: number) {
    await db.query(
      `INSERT INTO mastra_messages
        (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ($1, 'thread-1', $2::jsonb, $3, 'v2', $4, 'resource-1')`,
      [
        id,
        JSON.stringify({ format: 2, parts: [{ text: id, type: 'text' }] }),
        role,
        new Date(Date.UTC(2026, 7, 9, 12, minute)).toISOString(),
      ]
    );
  }

  it('round-trips an exact compacted-message set through the lookup', async () => {
    await insertMessage('summary-1', 'assistant', 3);
    await recordCompactionRange(
      {
        compactedMessageIds: ['raw-a', 'raw-b'],
        compactionMessageId: 'summary-1',
        kind: 'agentic',
        rewriteId: 'rewrite-1',
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
      },
      { getDatabase: databaseProvider, resetFileReads, resetLoopGuards }
    );

    await expect(
      createCompactionRangeLookup(databaseProvider).listActiveCompactionRanges('thread-1')
    ).resolves.toEqual([
      { compactedMessageIds: ['raw-a', 'raw-b'], compactionMessageId: 'summary-1' },
    ]);
    expect(resetLoopGuards).toHaveBeenCalledWith('thread-1');
    expect(resetFileReads).toHaveBeenCalledOnce();
  });

  it('self-heals across rewind when the summary is tombstoned', async () => {
    await insertMessage('raw-a', 'assistant', 0);
    await insertMessage('raw-b', 'assistant', 1);
    await insertMessage('summary-1', 'assistant', 2);
    await recordCompactionRange(
      {
        compactedMessageIds: ['raw-a', 'raw-b'],
        compactionMessageId: 'summary-1',
        kind: 'deterministic',
        rewriteId: 'rewrite-1',
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
      },
      { getDatabase: databaseProvider, resetFileReads, resetLoopGuards }
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_message_tombstones
        (message_id, thread_id, rewind_id)
       VALUES ('summary-1', 'thread-1', 'rewind-1')`
    );
    const visible = await db.query<{
      content: Message['content'];
      createdAt: Date;
      id: string;
      role: Message['role'];
    }>(
      `SELECT messages.id, messages.content, messages.role, messages."createdAt"
       FROM mastra_messages AS messages
       WHERE messages.thread_id = 'thread-1'
         AND NOT EXISTS (
           SELECT 1 FROM brainstrike_assistant_message_tombstones AS tombstones
           WHERE tombstones.message_id = messages.id
         )
       ORDER BY messages."createdAt", messages.id`
    );
    const messages = visible.rows as Message[];
    const processor = new CompactionOverlayProcessor(
      'thread-1',
      createCompactionRangeLookup(databaseProvider)
    );
    const result = await processor.processInputStep({
      abort: (reason?: string): never => {
        throw new Error(reason ?? 'processor aborted');
      },
      messageList: {} as ProcessInputStepArgs['messageList'],
      messages,
      model: {} as ProcessInputStepArgs['model'],
      retryCount: 0,
      state: {},
      stepNumber: 0,
      steps: [],
      systemMessages: [],
    });

    expect(result).toBeUndefined();
    expect(messages.map((message) => message.id)).toEqual(['raw-a', 'raw-b']);
  });
});
