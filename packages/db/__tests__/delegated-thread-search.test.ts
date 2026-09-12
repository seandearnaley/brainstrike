import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { readAssistantHistoryMessages } from '../src/repositories/assistant-history-repository.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { ThreadSearchRepository } from '../src/repositories/thread-search-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

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
    const dataDir = createPGliteTestDataDir('pglite-test-thread-search-repo');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
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

  it('searches owned descendants and rejects a changed intermediate native owner', async () => {
    await seedThread('search-root', 'Search root');
    const graph = createDelegatedConversationRepository(db);
    const scope = { ownerResourceId: RESOURCE_ID, rootThreadId: 'search-root' };
    await graph.registerRoot(scope);
    for (const [id, parent] of [
      ['search-child', 'search-root'],
      ['search-leaf', 'search-child'],
    ] as const) {
      await seedThread(id, 'quasarcobalt');
      await db.query('UPDATE mastra_threads SET "resourceId" = $2 WHERE id = $1', [
        id,
        `${id}-resource`,
      ]);
      await graph.createChild(scope, {
        color: 'blue',
        configuration: {},
        displayName: `Callsign ${id}`,
        parentThreadId: parent,
        resourceId: `${id}-resource`,
        threadId: id,
      });
      await seedMessage({
        content: v2Content('quasarcobalt'),
        id: `${id}-message`,
        role: 'assistant',
        threadId: id,
      });
      await db.query('UPDATE mastra_messages SET "resourceId" = $2 WHERE thread_id = $1', [
        id,
        `${id}-resource`,
      ]);
    }
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
      displayName: 'Callsign search-leaf',
      resourceId: 'search-leaf-resource',
      rootThreadId: 'search-root',
    });
    expect(
      await repository.getNavigationTarget(RESOURCE_ID, 'search-leaf', 'search-child-message')
    ).toBeNull();
    expect(
      await repository.getNavigationTarget('foreign-owner', 'search-leaf', 'search-leaf-message')
    ).toBeNull();
    await db.query('UPDATE mastra_threads SET "resourceId" = $1 WHERE id = $2', [
      'foreign-owner',
      'search-child',
    ]);
    expect(
      await repository.getNavigationTarget(RESOURCE_ID, 'search-leaf', 'search-leaf-message')
    ).toBeNull();
    expect(await repository.fullTextSearch('quasarcobalt', options)).toEqual([]);
    expect(await repository.searchSimilar(vec(0), options)).toEqual([]);
    expect(await repository.searchThreadTitles('quasarcobalt', options)).toEqual([]);
    expect(await repository.listNeedingEmbedding(options)).toEqual([]);
    expect(await repository.getCoverage(RESOURCE_ID)).toMatchObject({
      indexedMessages: 0,
      totalMessages: 0,
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
    await expect(
      readAssistantHistoryMessages(db, 'paged', RESOURCE_ID, { beforeMessageId: 'd' })
    ).rejects.toThrow('bounded page size');
  });
});
