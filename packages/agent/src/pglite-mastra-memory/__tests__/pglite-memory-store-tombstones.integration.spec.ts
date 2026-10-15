import type { PGlite } from '@electric-sql/pglite';
import type { MastraDBMessage } from '@mastra/core/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPristineBareTestDb } from '../../__tests__/helpers/migrated-agent-test-db';
import { PgliteMemoryStore } from '../memory-store';
import type { PgliteDatabase } from '../types';

/**
 * Soft-rewind read-path filtering (BST-1115, W5 T2).
 *
 * `PgliteMemoryStore` reaches `mastra_messages` from THREE places, and semantic
 * recall only touches one of them through the main WHERE clause:
 * 1. `listMessagesWhere` — `listMessages` / `listMessagesByResourceId`, which is
 *    also the whole of observational memory's message access,
 * 2. `findMessageRowById` — the include TARGET lookup,
 * 3. `listAdjacentThreadMessageRows` — the include NEIGHBOUR window.
 * Each is exercised separately here; collapsing them would let one seam regress
 * behind another's coverage.
 *
 * The tombstone table is a fixture here because the store does not own it:
 * migration 080 (and the app-shell bootstrap mirror) create it, and the store's
 * own `initialize()` creates only the Mastra schema. Keep this DDL in step with
 * `packages/db/src/migrations/080-assistant-message-tombstones.ts`.
 */
const TOMBSTONES_DDL = `
  CREATE TABLE IF NOT EXISTS brainstrike_assistant_message_tombstones (
    message_id text PRIMARY KEY,
    thread_id text NOT NULL,
    rewind_id text NOT NULL,
    revert_id text,
    tombstoned_at timestamptz NOT NULL DEFAULT NOW()
  );
`;

const THREAD_ID = 'thread-rewind';
const RESOURCE_ID = 'workspace-a';
const REWIND_ID = 'rewind-1';

function textMessage(id: string, createdAt: string): MastraDBMessage {
  return {
    content: { content: id, format: 2, parts: [{ text: id, type: 'text' }] },
    createdAt: new Date(createdAt),
    id,
    resourceId: RESOURCE_ID,
    role: id.endsWith('-assistant') ? 'assistant' : 'user',
    threadId: THREAD_ID,
    type: 'text',
  };
}

describe('PgliteMemoryStore soft-rewind tombstones', () => {
  let db: PGlite;
  let database: PgliteDatabase;
  let store: PgliteMemoryStore;

  async function tombstone(...messageIds: readonly string[]): Promise<void> {
    for (const messageId of messageIds) {
      await db.query(
        `INSERT INTO brainstrike_assistant_message_tombstones
           (message_id, thread_id, rewind_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, THREAD_ID, REWIND_ID]
      );
    }
  }

  /** Redo: the rewind batch is deleted and the content rows resurface untouched. */
  async function undoRewind(): Promise<void> {
    await db.query('DELETE FROM brainstrike_assistant_message_tombstones WHERE rewind_id = $1', [
      REWIND_ID,
    ]);
  }

  beforeEach(async () => {
    db = await createPristineBareTestDb();
    database = db as unknown as PgliteDatabase;
    store = new PgliteMemoryStore({ database });
    await store.initialize();
    await db.exec(TOMBSTONES_DDL);
    await store.saveThread({
      thread: {
        createdAt: new Date('2026-08-04T10:00:00Z'),
        id: THREAD_ID,
        resourceId: RESOURCE_ID,
        title: 'Rewind thread',
        updatedAt: new Date('2026-08-04T10:00:00Z'),
      },
    });
    await store.saveMessages({
      messages: [
        textMessage('message-1', '2026-08-04T10:00:01Z'),
        textMessage('message-2', '2026-08-04T10:00:02Z'),
        textMessage('message-3', '2026-08-04T10:00:03Z'),
        textMessage('message-4', '2026-08-04T10:00:04Z'),
        textMessage('message-5', '2026-08-04T10:00:05Z'),
      ],
    });
  });

  afterEach(async () => {
    await db.close();
  });

  describe('listMessagesWhere (listMessages / listMessagesByResourceId — also every OM read)', () => {
    it('hides a tombstoned message and counts only what it returns', async () => {
      await tombstone('message-4', 'message-5');

      const result = await store.listMessages({
        orderBy: { direction: 'ASC', field: 'createdAt' },
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
      ]);
      // total drives hasMore, so it must describe the VISIBLE set, not the rows.
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it('hides a tombstoned message from the resource-scoped read as well', async () => {
      await tombstone('message-5');

      const result = await store.listMessagesByResourceId({
        orderBy: { direction: 'ASC', field: 'createdAt' },
        resourceId: RESOURCE_ID,
      });

      expect(result.messages.map((message) => message.id)).not.toContain('message-5');
      expect(result.total).toBe(4);
    });

    it('restores visibility when the rewind batch is undone (redo)', async () => {
      await tombstone('message-4', 'message-5');
      await undoRewind();

      const result = await store.listMessages({
        orderBy: { direction: 'ASC', field: 'createdAt' },
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
        'message-4',
        'message-5',
      ]);
      expect(result.total).toBe(5);
    });
  });

  describe('findMessageRowById (semantic recall include targets)', () => {
    it('drops a tombstoned include target — and with it the target’s whole window', async () => {
      await tombstone('message-3');

      const result = await store.listMessages({
        include: [{ id: 'message-3', withNextMessages: 1, withPreviousMessages: 1 }],
        orderBy: { direction: 'ASC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      const ids = result.messages.map((message) => message.id);
      expect(ids).not.toContain('message-3');
      // A hidden target resolves to null, so `appendIncludedMessages` skips the
      // item entirely: its neighbours are never fetched either.
      expect(ids).toEqual(['message-1']);
    });

    it('restores the include target when the rewind batch is undone (redo)', async () => {
      await tombstone('message-3');
      await undoRewind();

      const result = await store.listMessages({
        include: [{ id: 'message-3' }],
        orderBy: { direction: 'ASC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual(['message-1', 'message-3']);
    });
  });

  describe('listAdjacentThreadMessageRows (semantic recall neighbour windows)', () => {
    it('TRUNCATES a backward window at the tombstone instead of reaching past it', async () => {
      await tombstone('message-3');

      const result = await store.listMessages({
        include: [{ id: 'message-5', withPreviousMessages: 3 }],
        orderBy: { direction: 'ASC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      // The window walks back message-4, message-3 (hidden), message-2 and stops
      // at the hole. Skip-over filtering would have returned message-2 as well,
      // presenting two turns that were never adjacent as adjacent context.
      expect(result.messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-4',
        'message-5',
      ]);
    });

    it('TRUNCATES a forward window at the tombstone instead of reaching past it', async () => {
      await tombstone('message-3');

      const result = await store.listMessages({
        include: [{ id: 'message-1', withNextMessages: 3 }],
        orderBy: { direction: 'DESC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual([
        'message-5',
        'message-2',
        'message-1',
      ]);
    });

    it('restores the full window when the rewind batch is undone (redo)', async () => {
      await tombstone('message-3');
      await undoRewind();

      const result = await store.listMessages({
        include: [{ id: 'message-5', withPreviousMessages: 3 }],
        orderBy: { direction: 'ASC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
        'message-4',
        'message-5',
      ]);
    });
  });

  describe('semantic-recall shape (include targets + neighbour windows together)', () => {
    it('leaks a tombstoned message neither as a hit nor as a neighbour of a live hit', async () => {
      await tombstone('message-3');

      const result = await store.listMessages({
        include: [
          // A recall hit that has since been rewound away.
          { id: 'message-3', withNextMessages: 1, withPreviousMessages: 1 },
          // A live recall hit whose backward window covers the rewound message.
          { id: 'message-5', withPreviousMessages: 3 },
        ],
        orderBy: { direction: 'ASC', field: 'createdAt' },
        perPage: 1,
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      const ids = result.messages.map((message) => message.id);
      expect(ids).not.toContain('message-3');
      expect(ids).toEqual(['message-1', 'message-4', 'message-5']);
      expect(result.total).toBe(4);
    });
  });

  describe('reload survival and sidecar presence', () => {
    it('still hides the message for a freshly constructed store (simulated reload)', async () => {
      await tombstone('message-4', 'message-5');

      // A reload rebuilds the store from nothing: new instance, new schema
      // bootstrap, new presence latch. The only thing that carries the rewind
      // across it is the persisted tombstone row.
      const reloadedStore = new PgliteMemoryStore({ database });
      await reloadedStore.initialize();

      const result = await reloadedStore.listMessages({
        orderBy: { direction: 'ASC', field: 'createdAt' },
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      });

      expect(result.messages.map((message) => message.id)).toEqual([
        'message-1',
        'message-2',
        'message-3',
      ]);
    });

    it('reads normally against a database that has no sidecar, and filters as soon as it appears', async () => {
      // A standalone store (no migrations, no app-shell bootstrap) is a real
      // configuration — `initialize()` creates only the Mastra schema.
      const bareDb = await createPristineBareTestDb();
      const bareStore = new PgliteMemoryStore({ database: bareDb as unknown as PgliteDatabase });
      await bareStore.initialize();
      await bareStore.saveThread({
        thread: {
          createdAt: new Date('2026-08-04T10:00:00Z'),
          id: THREAD_ID,
          resourceId: RESOURCE_ID,
          title: 'Rewind thread',
          updatedAt: new Date('2026-08-04T10:00:00Z'),
        },
      });
      await bareStore.saveMessages({
        messages: [textMessage('message-1', '2026-08-04T10:00:01Z')],
      });

      const listArgs = {
        orderBy: { direction: 'ASC', field: 'createdAt' },
        resourceId: RESOURCE_ID,
        threadId: THREAD_ID,
      } as const;

      await expect(bareStore.listMessages(listArgs)).resolves.toMatchObject({ total: 1 });

      // The absent answer is NOT latched: installing the sidecar afterwards must
      // start hiding immediately, or a store built before migrations ran would
      // ignore every rewind for the rest of the process's life.
      await bareDb.exec(TOMBSTONES_DDL);
      await bareDb.query(
        `INSERT INTO brainstrike_assistant_message_tombstones (message_id, thread_id, rewind_id)
         VALUES ('message-1', $1, $2)`,
        [THREAD_ID, REWIND_ID]
      );

      await expect(bareStore.listMessages(listArgs)).resolves.toMatchObject({
        messages: [],
        total: 0,
      });
      await bareDb.close();
    });
  });
});
