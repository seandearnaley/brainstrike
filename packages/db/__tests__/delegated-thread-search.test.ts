import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAssistantHistoryMessages } from '../src/repositories/assistant-history-repository.js';
import { ThreadSearchRepository } from '../src/repositories/thread-search-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const RESOURCE_ID = 'workspace-memory';
const PROFILE_DIMENSIONS = 384;
const PROFILE_MODEL_KEY = 'local::Xenova/all-MiniLM-L6-v2';

/** Deterministic unit-ish vector for similarity assertions. */
function vec(hot: number): number[] {
  const values = new Array<number>(PROFILE_DIMENSIONS).fill(0);
  values[hot % PROFILE_DIMENSIONS] = 1;
  return values;
}

function v2Content(text: string): string {
  return JSON.stringify({
    content: text,
    format: 2,
    parts: [{ text, type: 'text' }],
  });
}

describe('ThreadSearchRepository', () => {
  let db: PGlite;
  let repository: ThreadSearchRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
    repository = new ThreadSearchRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedThread(id: string, title: string, updatedAt = new Date()): Promise<void> {
    await db.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $4)`,
      [id, RESOURCE_ID, title, updatedAt]
    );
  }

  async function seedMessage(input: {
    content: string;
    createdAt?: Date;
    id: string;
    role: string;
    threadId: string;
  }): Promise<void> {
    await db.query(
      `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
      [
        input.id,
        input.threadId,
        input.content,
        input.role,
        input.createdAt ?? new Date(),
        RESOURCE_ID,
      ]
    );
  }

  it('searches only the selected resource and rejects a changed native owner', async () => {
    await seedThread('search-root', 'Search root');
    for (const id of ['search-child', 'search-leaf']) {
      await seedThread(id, 'quasarcobalt');
      await seedMessage({
        content: v2Content('quasarcobalt'),
        id: `${id}-message`,
        role: 'assistant',
        threadId: id,
      });
    }
    expect(
      (
        await repository.getNavigationTitles(RESOURCE_ID, [
          'search-root',
          'search-child',
          'search-leaf',
        ])
      )
        .map((row) => row.threadId)
        .sort()
    ).toEqual(['search-child', 'search-leaf', 'search-root']);
    expect(await repository.getNavigationTitles('foreign-owner', ['search-leaf'])).toEqual([]);
    await repository.sync();
    const options = { limit: 20, resourceId: RESOURCE_ID };
    expect(
      (await repository.fullTextSearch('quasarcobalt', options))
        .map((match) => match.threadId)
        .sort()
    ).toEqual(['search-child', 'search-leaf']);
    expect(
      (await repository.searchThreadTitles('quasarcobalt', options))
        .map((match) => match.threadId)
        .sort()
    ).toEqual(['search-child', 'search-leaf']);
    const pending = await repository.listNeedingEmbedding(options);
    expect(pending.map((row) => row.messageId).sort()).toEqual([
      'search-child-message',
      'search-leaf-message',
    ]);
    for (const row of pending) {
      await repository.storeEmbedding({ ...row, embedding: vec(0), modelKey: PROFILE_MODEL_KEY });
    }
    expect(
      (await repository.searchSimilar(vec(0), options)).map((match) => match.threadId).sort()
    ).toEqual(['search-child', 'search-leaf']);
    expect(await repository.getCoverage(RESOURCE_ID)).toMatchObject({
      embeddedMessages: 2,
      indexedMessages: 2,
      totalMessages: 2,
    });
    expect(
      await repository.fullTextSearch('quasarcobalt', { ...options, resourceId: 'foreign-owner' })
    ).toEqual([]);
    expect(
      await repository.getNavigationTarget(RESOURCE_ID, 'search-leaf', 'search-leaf-message')
    ).toMatchObject({
      displayName: null,
      resourceId: RESOURCE_ID,
      rootThreadId: 'search-leaf',
    });
    expect(
      await repository.getNavigationTarget(RESOURCE_ID, 'search-leaf', 'search-child-message')
    ).toBeNull();
    expect(
      await repository.getNavigationTarget('foreign-owner', 'search-leaf', 'search-leaf-message')
    ).toBeNull();
    await db.query('UPDATE mastra_threads SET "resourceId" = $1 WHERE id = $2', [
      'foreign-owner',
      'search-leaf',
    ]);
    expect(
      await repository.getNavigationTarget(RESOURCE_ID, 'search-leaf', 'search-leaf-message')
    ).toBeNull();
    expect(
      await repository.getNavigationTitles(RESOURCE_ID, ['search-child', 'search-leaf'])
    ).toMatchObject([{ threadId: 'search-child' }]);
    expect(
      (await repository.fullTextSearch('quasarcobalt', options)).map((row) => row.threadId)
    ).toEqual(['search-child']);
    expect((await repository.searchSimilar(vec(0), options)).map((row) => row.threadId)).toEqual([
      'search-child',
    ]);
    expect(
      (await repository.searchThreadTitles('quasarcobalt', options)).map((row) => row.threadId)
    ).toEqual(['search-child']);
    expect(await repository.listNeedingEmbedding(options)).toEqual([]);
    expect(await repository.getCoverage(RESOURCE_ID)).toMatchObject({
      indexedMessages: 1,
      totalMessages: 1,
    });
  });

  it('pages an exact same-timestamp cursor only inside its native owner and thread', async () => {
    await seedThread('paged', 'Paged');
    await seedThread('other', 'Other');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await seedMessage({
        content: v2Content(id),
        createdAt: new Date('2026-09-01'),
        id,
        role: 'user',
        threadId: 'paged',
      });
    }
    await seedMessage({
      content: v2Content('foreign'),
      id: 'foreign',
      role: 'user',
      threadId: 'other',
    });
    expect(
      (await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, { limitLatest: 2 })).map(
        (row) => row.id
      )
    ).toEqual(['d', 'e']);
    expect(
      (
        await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
          beforeMessageId: 'd',
          limitLatest: 2,
        })
      ).map((row) => row.id)
    ).toEqual(['b', 'c']);
    expect(
      await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
        beforeMessageId: 'foreign',
        limitLatest: 2,
      })
    ).toEqual([]);
    expect(
      await readAssistantHistoryMessages(db, 'paged', 'foreign-owner', {
        beforeMessageId: 'd',
        limitLatest: 2,
      })
    ).toEqual([]);
    expect(
      await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
        limitLatest: 2,
        targetMessageId: 'removed',
      })
    ).toEqual([]);
    expect(
      (
        await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
          beforeMessageId: 'd',
          limitLatest: 2,
          targetMessageId: 'a',
        })
      ).map((row) => row.id)
    ).toEqual(['b', 'c']);
    await db.query('UPDATE mastra_messages SET "resourceId" = NULL WHERE id IN ($1, $2)', [
      'a',
      'd',
    ]);
    expect(
      (
        await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
          limitLatest: 5,
          targetMessageId: 'a',
        })
      ).map((row) => row.id)
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(
      (
        await readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, {
          beforeMessageId: 'd',
          limitLatest: 2,
          targetMessageId: 'a',
        })
      ).map((row) => row.id)
    ).toEqual(['b', 'c']);
    expect(
      await readAssistantHistoryMessages(db, 'paged', 'foreign-owner', {
        limitLatest: 2,
        targetMessageId: 'a',
      })
    ).toEqual([]);
    await expect(
      readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, { beforeMessageId: 'd' })
    ).rejects.toThrow('bounded page size');
  });
});
