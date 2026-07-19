import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
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

function v2ToolOnlyContent(): string {
  return JSON.stringify({
    content: '',
    format: 2,
    parts: [
      {
        toolInvocation: {
          args: { query: 'secret payload should not be indexed' },
          state: 'result',
          toolCallId: 'call-1',
          toolName: 'brainstrike.hybridSearch',
        },
        type: 'tool-invocation',
      },
    ],
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

  describe('sync', () => {
    it('indexes new v2 messages, extracting only text parts', async () => {
      await seedThread('thread-1', 'HNSW tuning');
      await seedMessage({
        content: v2Content('How should I tune hnsw ef_search for pglite?'),
        id: 'msg-user',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2ToolOnlyContent(),
        id: 'msg-tool-only',
        role: 'assistant',
        threadId: 'thread-1',
      });

      const result = await repository.sync();
      expect(result.inserted).toBe(2);

      const rows = await db.query<{ content_text: string; message_id: string }>(
        'SELECT message_id, content_text FROM brainstrike_thread_message_index ORDER BY message_id'
      );
      expect(rows.rows).toHaveLength(2);
      const byId = new Map(rows.rows.map((row) => [row.message_id, row.content_text]));
      expect(byId.get('msg-user')).toBe('How should I tune hnsw ef_search for pglite?');
      // Tool payloads are never indexed: the tool-only row keeps an empty text.
      expect(byId.get('msg-tool-only')).toBe('');
    });

    it('indexes legacy plain-string content', async () => {
      await seedThread('thread-1', 'Legacy');
      await seedMessage({
        content: JSON.stringify('plain legacy body about embeddings'),
        id: 'msg-legacy',
        role: 'assistant',
        threadId: 'thread-1',
      });

      await repository.sync();

      const rows = await db.query<{ content_text: string }>(
        `SELECT content_text FROM brainstrike_thread_message_index WHERE message_id = 'msg-legacy'`
      );
      expect(rows.rows[0]?.content_text).toBe('plain legacy body about embeddings');
    });

    it('stores empty text for non-conversational roles', async () => {
      await seedThread('thread-1', 'Roles');
      await seedMessage({
        content: v2Content('internal system directive text'),
        id: 'msg-system',
        role: 'system',
        threadId: 'thread-1',
      });

      await repository.sync();

      const rows = await db.query<{ content_text: string }>(
        `SELECT content_text FROM brainstrike_thread_message_index WHERE message_id = 'msg-system'`
      );
      expect(rows.rows[0]?.content_text).toBe('');
    });

    it('is idempotent and reports zero work on a second run', async () => {
      await seedThread('thread-1', 'Idempotent');
      await seedMessage({
        content: v2Content('first body'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });

      const first = await repository.sync();
      expect(first.inserted).toBe(1);
      const second = await repository.sync();
      expect(second.inserted).toBe(0);
      expect(second.refreshed).toBe(0);
    });

    it('refreshes changed content in recently-active threads and resets the embedding', async () => {
      await seedThread('thread-1', 'Progressive saves');
      await seedMessage({
        content: v2Content('partial answer'),
        id: 'msg-1',
        role: 'assistant',
        threadId: 'thread-1',
      });
      await repository.sync();
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-1'),
        embedding: vec(1),
        messageId: 'msg-1',
        modelKey: PROFILE_MODEL_KEY,
      });

      // Progressive per-step save: same id, new content; the thread activity bumps.
      await db.query(`UPDATE mastra_messages SET content = $1::jsonb WHERE id = 'msg-1'`, [
        v2Content('partial answer plus the final resolution'),
      ]);
      await db.query(`UPDATE mastra_threads SET "updatedAt" = NOW() WHERE id = 'thread-1'`);

      const result = await repository.sync();
      expect(result.refreshed).toBe(1);

      const rows = await db.query<{ content_text: string; has_embedding: boolean }>(
        `SELECT content_text, embedding IS NOT NULL AS has_embedding
         FROM brainstrike_thread_message_index WHERE message_id = 'msg-1'`
      );
      expect(rows.rows[0]?.content_text).toBe('partial answer plus the final resolution');
      expect(rows.rows[0]?.has_embedding).toBe(false);
    });

    it('refreshes a quiet thread even when another thread is far ahead (per-thread state)', async () => {
      // Regression for the global-watermark design: thread A's pending change
      // must not be skippable because thread B pushed activity far past it.
      const past = new Date(Date.now() - 30 * 60_000);
      await seedThread('thread-a', 'Quiet', past);
      await seedThread('thread-b', 'Busy', past);
      await seedMessage({
        content: v2Content('original quiet content'),
        createdAt: past,
        id: 'msg-a',
        role: 'user',
        threadId: 'thread-a',
      });
      await repository.sync();

      // Thread B races far ahead; the sweep records its activity.
      await db.query(`UPDATE mastra_threads SET "updatedAt" = NOW() WHERE id = 'thread-b'`);
      await repository.sync();

      // Thread A's same-id content changes with only a TINY updatedAt bump —
      // still far behind B, and outside the trailing live window.
      await db.query(`UPDATE mastra_messages SET content = $1::jsonb WHERE id = 'msg-a'`, [
        v2Content('rewritten quiet content'),
      ]);
      await db.query(
        `UPDATE mastra_threads SET "updatedAt" = "updatedAt" + INTERVAL '1 second' WHERE id = 'thread-a'`
      );

      const result = await repository.sync();
      expect(result.refreshed).toBe(1);
      const rows = await db.query<{ content_text: string }>(
        `SELECT content_text FROM brainstrike_thread_message_index WHERE message_id = 'msg-a'`
      );
      expect(rows.rows[0]?.content_text).toBe('rewritten quiet content');
    });

    it('refreshes when only the role changes (role is part of the source hash)', async () => {
      await seedThread('thread-1', 'Roles change');
      await seedMessage({
        content: v2Content('same content either way'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();

      // Same content, but the role flips to a non-conversational one: the
      // previously searchable text must be withdrawn.
      await db.query(`UPDATE mastra_messages SET role = 'system' WHERE id = 'msg-1'`);
      await db.query(`UPDATE mastra_threads SET "updatedAt" = NOW() WHERE id = 'thread-1'`);
      await repository.sync();

      const rows = await db.query<{ content_text: string; role: string }>(
        `SELECT content_text, role FROM brainstrike_thread_message_index WHERE message_id = 'msg-1'`
      );
      expect(rows.rows[0]?.role).toBe('system');
      expect(rows.rows[0]?.content_text).toBe('');
    });

    it('garbage-collects index rows whose message is gone', async () => {
      await seedThread('thread-1', 'GC');
      await seedMessage({
        content: v2Content('doomed'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();

      await db.query(`DELETE FROM mastra_messages WHERE id = 'msg-1'`);
      const result = await repository.sync();
      expect(result.deletedOrphans).toBe(1);

      const rows = await db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM brainstrike_thread_message_index'
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  });

  async function currentHash(messageId: string): Promise<string> {
    const rows = await db.query<{ content_hash: string }>(
      'SELECT content_hash FROM brainstrike_thread_message_index WHERE message_id = $1',
      [messageId]
    );
    const hash = rows.rows[0]?.content_hash;
    if (!hash) {
      throw new Error(`No index row for ${messageId}`);
    }
    return hash;
  }

  describe('full-text search', () => {
    beforeEach(async () => {
      await seedThread('thread-vec', 'Vector tuning');
      await seedThread('thread-cook', 'Dinner plans');
      await seedMessage({
        content: v2Content('We should tune hnsw ef_search and iterative scan for recall.'),
        id: 'msg-vec',
        role: 'assistant',
        threadId: 'thread-vec',
      });
      await seedMessage({
        content: v2Content('Pasta with garlic and olive oil tonight.'),
        id: 'msg-cook',
        role: 'user',
        threadId: 'thread-cook',
      });
      await repository.sync();
    });

    it('returns ranked matches with highlighted headlines', async () => {
      const matches = await repository.fullTextSearch('hnsw recall', {
        limit: 10,
        resourceId: RESOURCE_ID,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.messageId).toBe('msg-vec');
      expect(matches[0]?.threadId).toBe('thread-vec');
      expect(matches[0]?.rank).toBeGreaterThan(0);
      expect(matches[0]?.headline).toContain('<mark>');
      expect(matches[0]?.messageCreatedAt).toBeInstanceOf(Date);
    });

    it('scopes by resource id', async () => {
      const matches = await repository.fullTextSearch('hnsw', {
        limit: 10,
        resourceId: 'another-resource',
      });
      expect(matches).toHaveLength(0);
    });

    it('rejects a blank query', async () => {
      await expect(
        repository.fullTextSearch('   ', { limit: 10, resourceId: RESOURCE_ID })
      ).rejects.toThrow(/query/i);
    });
  });

  describe('vector search', () => {
    it('returns similar messages above the threshold with snippets', async () => {
      await seedThread('thread-1', 'Similarity');
      await seedMessage({
        content: v2Content('close neighbor'),
        id: 'msg-close',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2Content('distant point'),
        id: 'msg-far',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-close'),
        embedding: vec(1),
        messageId: 'msg-close',
        modelKey: PROFILE_MODEL_KEY,
      });
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-far'),
        embedding: vec(2),
        messageId: 'msg-far',
        modelKey: PROFILE_MODEL_KEY,
      });

      const matches = await repository.searchSimilar(vec(1), {
        limit: 10,
        resourceId: RESOURCE_ID,
        threshold: 0.5,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.messageId).toBe('msg-close');
      expect(matches[0]?.similarity).toBeCloseTo(1, 5);
      expect(matches[0]?.snippet).toBe('close neighbor');
    });

    it('rejects a dimension mismatch instead of degrading', async () => {
      await expect(
        repository.searchSimilar([1, 2, 3], { limit: 10, resourceId: RESOURCE_ID })
      ).rejects.toThrow(/dimension/i);
    });
  });

  describe('embedding lifecycle', () => {
    it('lists pending rows newest-first and CASes stores on content hash', async () => {
      await seedThread('thread-1', 'Pending');
      await seedMessage({
        content: v2Content('older text'),
        createdAt: new Date('2026-07-01T00:00:00Z'),
        id: 'msg-old',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2Content('newer text'),
        createdAt: new Date('2026-07-02T00:00:00Z'),
        id: 'msg-new',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2ToolOnlyContent(),
        id: 'msg-empty',
        role: 'assistant',
        threadId: 'thread-1',
      });
      await repository.sync();

      const pending = await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID });
      expect(pending.map((row) => row.messageId)).toEqual(['msg-new', 'msg-old']);

      const stored = await repository.storeEmbedding({
        contentHash: pending[0]?.contentHash ?? '',
        embedding: vec(1),
        messageId: 'msg-new',
        modelKey: PROFILE_MODEL_KEY,
      });
      expect(stored).toBe(true);

      // A stale hash (content changed since listing) must not store.
      const stale = await repository.storeEmbedding({
        contentHash: 'stale-hash',
        embedding: vec(1),
        messageId: 'msg-old',
        modelKey: PROFILE_MODEL_KEY,
      });
      expect(stale).toBe(false);

      const remaining = await repository.listNeedingEmbedding({
        limit: 10,
        resourceId: RESOURCE_ID,
      });
      expect(remaining.map((row) => row.messageId)).toEqual(['msg-old']);
    });

    it('records embedding errors and excludes them from the pending list', async () => {
      await seedThread('thread-1', 'Errors');
      await seedMessage({
        content: v2Content('will fail'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();

      const marked = await repository.markEmbeddingError({
        contentHash: await currentHash('msg-1'),
        error: 'model exploded',
        messageId: 'msg-1',
      });
      expect(marked).toBe(true);
      expect(
        await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID })
      ).toHaveLength(0);

      const coverage = await repository.getCoverage(RESOURCE_ID);
      expect(coverage.erroredMessages).toBe(1);
    });

    it('refuses to store a vector produced by a different model than the profile', async () => {
      await seedThread('thread-1', 'Model swap');
      await seedMessage({
        content: v2Content('embed me'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();

      const stored = await repository.storeEmbedding({
        contentHash: await currentHash('msg-1'),
        embedding: vec(1),
        messageId: 'msg-1',
        modelKey: 'local::some-other-model',
      });
      expect(stored).toBe(false);
      expect(
        await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID })
      ).toHaveLength(1);
    });

    it('scopes the pending-embedding list by resource', async () => {
      await seedThread('thread-1', 'Mine');
      await seedMessage({
        content: v2Content('mine'),
        id: 'msg-mine',
        role: 'user',
        threadId: 'thread-1',
      });
      await db.query(
        `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
         VALUES ('thread-other', 'other-resource', 'Other', NOW(), NOW())`
      );
      await db.query(
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ('msg-other', 'thread-other', $1::jsonb, 'user', 'v2', NOW(), 'other-resource')`,
        [v2Content('someone elses')]
      );
      await repository.sync();

      const pending = await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID });
      expect(pending.map((row) => row.messageId)).toEqual(['msg-mine']);
    });

    it('rejects embeddings that do not match the profile dimensions', async () => {
      await expect(
        repository.storeEmbedding({
          contentHash: 'x',
          embedding: [1, 2],
          messageId: 'msg',
          modelKey: PROFILE_MODEL_KEY,
        })
      ).rejects.toThrow(/dimension/i);
    });
  });

  describe('thread titles', () => {
    it('matches titles case-insensitively, ranked by similarity', async () => {
      await seedThread('thread-1', 'HNSW parameter tuning');
      await seedThread('thread-2', 'Grocery list');

      const matches = await repository.searchThreadTitles('hnsw tuning', {
        limit: 10,
        resourceId: RESOURCE_ID,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.threadId).toBe('thread-1');
      expect(matches[0]?.similarity).toBeGreaterThan(0);
    });
  });

  describe('coverage + cleanup', () => {
    it('reports honest coverage counts', async () => {
      await seedThread('thread-1', 'Coverage');
      await seedMessage({
        content: v2Content('embed me'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2ToolOnlyContent(),
        id: 'msg-2',
        role: 'assistant',
        threadId: 'thread-1',
      });

      const before = await repository.getCoverage(RESOURCE_ID);
      expect(before.totalMessages).toBe(2);
      expect(before.indexedMessages).toBe(0);

      await repository.sync();
      const after = await repository.getCoverage(RESOURCE_ID);
      expect(after.indexedMessages).toBe(2);
      expect(after.embeddableMessages).toBe(1);
      expect(after.embeddedMessages).toBe(0);

      await repository.storeEmbedding({
        contentHash: await currentHash('msg-1'),
        embedding: vec(1),
        messageId: 'msg-1',
        modelKey: PROFILE_MODEL_KEY,
      });
      const embedded = await repository.getCoverage(RESOURCE_ID);
      expect(embedded.embeddedMessages).toBe(1);
    });

    it('deletes index rows for deleted threads', async () => {
      await seedThread('thread-1', 'Doomed');
      await seedThread('thread-2', 'Kept');
      await seedMessage({
        content: v2Content('a'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await seedMessage({
        content: v2Content('b'),
        id: 'msg-2',
        role: 'user',
        threadId: 'thread-2',
      });
      await repository.sync();

      await repository.deleteThreads(['thread-1']);

      const rows = await db.query<{ thread_id: string }>(
        'SELECT thread_id FROM brainstrike_thread_message_index'
      );
      expect(rows.rows.map((row) => row.thread_id)).toEqual(['thread-2']);
    });
  });
});
