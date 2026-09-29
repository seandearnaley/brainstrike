import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    it('seeds refresh state for every thread on first sync without re-extracting', async () => {
      // Regression for the unbounded first-sync scan: a never-seen thread is
      // seeded into the refresh state (so a later sync sees it as up to date)
      // rather than triggering full corpus re-extraction.
      for (let i = 0; i < 3; i += 1) {
        await seedThread(`thread-${i}`, `Thread ${i}`);
        await seedMessage({
          content: v2Content(`body ${i}`),
          id: `msg-${i}`,
          role: 'user',
          threadId: `thread-${i}`,
        });
      }

      const first = await repository.sync();
      expect(first.inserted).toBe(3);

      const state = await db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM brainstrike_thread_search_state'
      );
      expect(Number(state.rows[0]?.count)).toBe(3);

      // An unchanged second sync does zero refresh work (nothing re-extracted).
      const second = await repository.sync();
      expect(second.inserted).toBe(0);
      expect(second.refreshed).toBe(0);
    });

    it('bounds the refresh to the thread batch, making progress across passes', async () => {
      const changedAt = new Date();
      for (let i = 0; i < 3; i += 1) {
        await seedThread(`thread-${i}`, `Thread ${i}`, new Date(Date.now() - 60 * 60_000));
        await seedMessage({
          content: v2Content(`original ${i}`),
          id: `msg-${i}`,
          role: 'user',
          threadId: `thread-${i}`,
        });
      }
      await repository.sync();

      // All three threads change well outside the live window.
      for (let i = 0; i < 3; i += 1) {
        await db.query(`UPDATE mastra_messages SET content = $1::jsonb WHERE id = 'msg-${i}'`, [
          v2Content(`rewritten ${i}`),
        ]);
        await db.query(`UPDATE mastra_threads SET "updatedAt" = $1 WHERE id = 'thread-${i}'`, [
          changedAt,
        ]);
      }

      // A refresh batch of 2 handles two threads this pass...
      const pass1 = await repository.sync({ refreshThreadBatch: 2 });
      expect(pass1.refreshed).toBe(2);
      // ...and the remaining thread on the next pass.
      const pass2 = await repository.sync({ refreshThreadBatch: 2 });
      expect(pass2.refreshed).toBe(1);
      const pass3 = await repository.sync({ refreshThreadBatch: 2 });
      expect(pass3.refreshed).toBe(0);
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

  describe('soft-rewind tombstones (BST-1115)', () => {
    async function tombstone(messageId: string, threadId: string): Promise<void> {
      await db.query(
        `INSERT INTO brainstrike_assistant_message_tombstones (message_id, thread_id, rewind_id)
         VALUES ($1, $2, 'rewind-1')`,
        [messageId, threadId]
      );
    }

    async function undoRewind(): Promise<void> {
      await db.query(
        `DELETE FROM brainstrike_assistant_message_tombstones WHERE rewind_id = 'rewind-1'`
      );
    }

    beforeEach(async () => {
      await seedThread('thread-rewind', 'Rewound conversation');
      await seedMessage({
        content: v2Content('We should tune hnsw ef_search and iterative scan for recall.'),
        id: 'msg-kept',
        role: 'assistant',
        threadId: 'thread-rewind',
      });
      await seedMessage({
        content: v2Content('Actually tune hnsw the other way, ignore the iterative scan.'),
        id: 'msg-rewound',
        role: 'assistant',
        threadId: 'thread-rewind',
      });
      await repository.sync();
    });

    it('drops a tombstoned message from the lexical arm', async () => {
      await tombstone('msg-rewound', 'thread-rewind');

      const matches = await repository.fullTextSearch('hnsw', {
        limit: 10,
        resourceId: RESOURCE_ID,
      });

      expect(matches.map((match) => match.messageId)).toEqual(['msg-kept']);
    });

    it('drops a tombstoned message from the semantic arm', async () => {
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-kept'),
        embedding: vec(1),
        messageId: 'msg-kept',
        modelKey: PROFILE_MODEL_KEY,
      });
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-rewound'),
        embedding: vec(1),
        messageId: 'msg-rewound',
        modelKey: PROFILE_MODEL_KEY,
      });
      await tombstone('msg-rewound', 'thread-rewind');

      const matches = await repository.searchSimilar(vec(1), {
        limit: 10,
        resourceId: RESOURCE_ID,
        threshold: 0.5,
      });

      expect(matches.map((match) => match.messageId)).toEqual(['msg-kept']);
    });

    it('restores both arms when the rewind batch is undone (redo)', async () => {
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-rewound'),
        embedding: vec(1),
        messageId: 'msg-rewound',
        modelKey: PROFILE_MODEL_KEY,
      });
      await tombstone('msg-rewound', 'thread-rewind');
      await undoRewind();

      const lexical = await repository.fullTextSearch('hnsw', {
        limit: 10,
        resourceId: RESOURCE_ID,
      });
      const semantic = await repository.searchSimilar(vec(1), {
        limit: 10,
        resourceId: RESOURCE_ID,
        threshold: 0.5,
      });

      expect(lexical.map((match) => match.messageId).sort()).toEqual(['msg-kept', 'msg-rewound']);
      expect(semantic.map((match) => match.messageId)).toEqual(['msg-rewound']);
    });

    it('keeps the index row and its embedding while the message is hidden', async () => {
      await repository.storeEmbedding({
        contentHash: await currentHash('msg-rewound'),
        embedding: vec(1),
        messageId: 'msg-rewound',
        modelKey: PROFILE_MODEL_KEY,
      });
      await tombstone('msg-rewound', 'thread-rewind');

      // Filtering happens at the SEARCH ARMS only. If sync skipped tombstoned
      // rows instead, the source/index count fast path would never agree again
      // and redo would owe a re-embed. Both must hold: a second pass reports no
      // work, and the vector survives.
      const result = await repository.sync();
      expect(result).toMatchObject({ deletedOrphans: 0, inserted: 0 });
      const rows = await db.query<{ embedded: boolean }>(
        `SELECT embedding IS NOT NULL AS embedded
         FROM brainstrike_thread_message_index WHERE message_id = 'msg-rewound'`
      );
      expect(rows.rows[0]?.embedded).toBe(true);
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

    it('revives an aged errored row on sync so a transient failure self-heals', async () => {
      await seedThread('thread-1', 'Aged error');
      await seedMessage({
        content: v2Content('transiently failed'),
        id: 'msg-1',
        role: 'user',
        threadId: 'thread-1',
      });
      await repository.sync();
      await repository.markEmbeddingError({
        contentHash: await currentHash('msg-1'),
        error: 'model still initializing',
        messageId: 'msg-1',
      });

      // A fresh error is NOT revived (still within the cooldown).
      await repository.sync();
      expect(
        await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID })
      ).toHaveLength(0);

      // Age the failed attempt past the cooldown (5 min).
      await db.query(
        `UPDATE brainstrike_thread_message_index
         SET embedding_updated_at = CURRENT_TIMESTAMP - INTERVAL '10 minutes'
         WHERE message_id = 'msg-1'`
      );
      await repository.sync();

      // The row is back in the pending set; coverage no longer counts it errored.
      const pending = await repository.listNeedingEmbedding({ limit: 10, resourceId: RESOURCE_ID });
      expect(pending.map((row) => row.messageId)).toEqual(['msg-1']);
      const coverage = await repository.getCoverage(RESOURCE_ID);
      expect(coverage.erroredMessages).toBe(0);
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

  describe('searchSimilar HNSW tuning transaction (mock db — no PGlite needed)', () => {
    const PROFILE_ROW = {
      dimensions: PROFILE_DIMENSIONS,
      distance: 'cosine',
      id: 'profile-1',
      modelId: 'model-1',
      modelKey: PROFILE_MODEL_KEY,
    };

    function profileAwareQuery(calls: { params?: unknown[]; sql: string }[]) {
      return async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        calls.push({ params, sql });
        if (sql.includes('thread_search_profiles')) {
          return { rows: [PROFILE_ROW] as T[] };
        }
        return { rows: [] as T[] };
      };
    }

    it('routes the vector arm through runTransaction with SET LOCAL tuning ahead of the SELECT', async () => {
      const queryCalls: { params?: unknown[]; sql: string }[] = [];
      const runTransaction = vi.fn(async (statements: { sql: string }[], resultIndex: number) => {
        expect(resultIndex).toBe(statements.length - 1);
        return { rows: [] };
      });
      const mockRepository = new ThreadSearchRepository({
        query: profileAwareQuery(queryCalls),
        runTransaction,
      });

      await mockRepository.searchSimilar(vec(1), { limit: 5, resourceId: RESOURCE_ID });

      expect(runTransaction).toHaveBeenCalledTimes(1);
      const [statements] = runTransaction.mock.calls[0] as [
        { params?: unknown[]; sql: string }[],
        number,
      ];
      // Positional prefix + trailing-SELECT assertions (not toEqual): the
      // tuning helper appends an ivfflat.probes statement when IVFFLAT_PROBES
      // is set, and this test must not couple to that env-dependent extra.
      expect(statements[0]?.sql).toContain('SET LOCAL hnsw.ef_search');
      expect(statements[1]?.sql).toContain('SET LOCAL hnsw.iterative_scan');
      expect(statements.at(-1)?.sql).toContain('SELECT');
      expect(statements.slice(0, -1).every((s) => s.sql.startsWith('SET LOCAL'))).toBe(true);
      // The vector SELECT itself must not have gone through bare query().
      expect(queryCalls.every((call) => !call.sql.includes('<=>'))).toBe(true);
    });

    it('propagates IPC statement-list transaction failures', async () => {
      const queryCalls: { params?: unknown[]; sql: string }[] = [];
      const failure = new Error('desktop transaction failed');
      const mockRepository = new ThreadSearchRepository({
        query: profileAwareQuery(queryCalls),
        runTransaction: vi.fn().mockRejectedValue(failure),
      });

      await expect(
        mockRepository.searchSimilar(vec(1), { limit: 5, resourceId: RESOURCE_ID })
      ).rejects.toBe(failure);
      expect(queryCalls.some((call) => call.sql.includes('<=>'))).toBe(false);
    });

    it('uses the callback-style transaction for web scheduled handles and raw PGlite', async () => {
      const outerCalls: { params?: unknown[]; sql: string }[] = [];
      const txCalls: { params?: unknown[]; sql: string }[] = [];
      const transaction = vi.fn(
        async <T>(fn: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> =>
          await fn({ query: txQuery })
      );
      const txQuery = async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        txCalls.push({ params, sql });
        return { rows: [] as T[] };
      };
      const mockRepository = new ThreadSearchRepository({
        query: profileAwareQuery(outerCalls),
        transaction,
      });

      await mockRepository.searchSimilar(vec(1), { limit: 5, resourceId: RESOURCE_ID });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(txCalls[0]?.sql).toContain('SET LOCAL hnsw.ef_search');
      expect(txCalls[1]?.sql).toContain('SET LOCAL hnsw.iterative_scan');
      expect(txCalls.at(-1)?.sql).toContain('<=>');
      // No BEGIN/COMMIT and no vector SELECT on the outer connection.
      expect(outerCalls.every((call) => call.sql !== 'BEGIN' && !call.sql.includes('<=>'))).toBe(
        true
      );
    });

    it('rejects query-only handles instead of opening a multi-call transaction', async () => {
      const queryCalls: { params?: unknown[]; sql: string }[] = [];
      const mockRepository = new ThreadSearchRepository({
        query: profileAwareQuery(queryCalls),
      });

      await expect(
        mockRepository.searchSimilar(vec(1), { limit: 5, resourceId: RESOURCE_ID })
      ).rejects.toThrow('Thread search vector search requires atomic transaction support.');
      expect(queryCalls.some((call) => call.sql.startsWith('SET LOCAL'))).toBe(false);
      expect(queryCalls.some((call) => call.sql.trim() === 'BEGIN')).toBe(false);
    });

    it('propagates callback transaction SELECT failures', async () => {
      const queryCalls: { params?: unknown[]; sql: string }[] = [];
      const outerQuery = async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
        queryCalls.push({ params, sql });
        if (sql.includes('thread_search_profiles')) {
          return { rows: [PROFILE_ROW] as T[] };
        }
        return { rows: [] as T[] };
      };
      const transaction = async <T>(
        operation: (tx: { query: typeof outerQuery }) => Promise<T>
      ): Promise<T> =>
        await operation({
          query: async <R>(sql: string, _params?: unknown[]): Promise<{ rows: R[] }> => {
            if (sql.includes('<=>')) {
              throw new Error('vector search exploded');
            }
            return { rows: [] as R[] };
          },
        });
      const mockRepository = new ThreadSearchRepository({ query: outerQuery, transaction });

      await expect(
        mockRepository.searchSimilar(vec(1), { limit: 5, resourceId: RESOURCE_ID })
      ).rejects.toThrow('vector search exploded');
      expect(queryCalls.some((call) => call.sql.trim() === 'ROLLBACK')).toBe(false);
    });
  });
});
