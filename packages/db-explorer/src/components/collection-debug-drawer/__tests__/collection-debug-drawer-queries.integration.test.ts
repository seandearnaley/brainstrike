/**
 * Collection debug drawer SQL (BST-1214) — real PGlite integration.
 *
 * The drawer's two reads live in `packages/db-explorer` and are unit-tested
 * against a mocked query function, which can prove WHAT SQL is sent but never
 * that the SQL parses or that the columns exist. This suite runs the exact
 * statements against a migrated database.
 *
 * It exists because of a specific review finding: the first version derived
 * chunk/set identity with `split_part(job_queue.dedupe_key, ':', N)`, which
 * silently returned zero failures under the `embed:<chunkId>:<setId>:<modelKey>`
 * key format the pipeline builder then produced. The rewrite reads the
 * first-class `chunk_id` / `embedding_set_id` columns instead, and the
 * assertions below pin the behaviour that string-parsing got wrong. #2364 later
 * unified the key producers, which removes the format DIVERGENCE but not the
 * hazard — the canonical key is explicitly documented as unparseable.
 *
 * The SQL is imported from the drawer module itself, not copied: a copy would
 * be the "same SQL drifting apart" channel this codebase repeatedly closes, and
 * a green copy would prove nothing about what the drawer actually sends.
 *
 * It lives HERE, beside the module under test, rather than in `packages/db`.
 * The first version sat in `packages/db/__tests__` and reached back into
 * db-explorer source, which inverts the package graph — `db-explorer` depends
 * on `db`, not the reverse — and `turbo boundaries` failed it. This direction
 * is an ordinary in-package relative import, and `migrate`/`wasmLoader` are
 * public exports of `@brainstrike/db` (star re-exported from its entry point).
 */

import { migrate, wasmLoader } from '@brainstrike/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHUNKS_FOR_FILE_QUERY as CHUNKS_FOR_FILE_SQL,
  INCOMPLETE_FILES_QUERY as INCOMPLETE_FILES_SQL,
} from '../collection-debug-queries';

/**
 * Derived from the loader rather than imported from `@electric-sql/pglite`:
 * db-explorer does not depend on that package (it reaches the database only
 * through `@brainstrike/db`), and `turbo boundaries` rightly rejects importing
 * an undeclared one — even for a type. Adding the dependency to annotate a
 * single local would be the wrong direction.
 */
type PGlite = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

const SET_ID = 'set-primary';
const OTHER_SET_ID = 'set-other';

interface ChunkRow {
  chunkIndex: number;
  content: string;
  embeddingDimensions: number;
  failed: boolean;
  hasEmbedding: boolean;
  id: string;
  tokenCount: number;
}

interface IncompleteRow {
  chunksCount: number;
  chunksProcessed: boolean;
  embeddedChunksCount: number;
  failedChunksCount: number;
  id: string;
  name: string;
  path: string | null;
}

async function insertChunk(
  db: PGlite,
  args: { id: string; fileRecordId: string; index: number; embedded: boolean; setId: string }
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO file_chunks
       (id, file_record_id, chunk_index, content, content_hash, token_count,
        embedding, embedding_set_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10)`,
    [
      args.id,
      args.fileRecordId,
      args.index,
      `body of ${args.id}`,
      `hash-${args.id}`,
      7,
      args.embedded ? '[1,2,3]' : null,
      args.setId,
      now,
      now,
    ]
  );
}

async function insertFailedEmbedJob(
  db: PGlite,
  args: { chunkId: string; setId: string; dedupeKey: string }
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO job_queue
       (id, queue, job_type, state, chunk_id, embedding_set_id, dedupe_key,
        run_at, created_at, updated_at)
     VALUES ($1, 'embeddings', 'embed_chunk', 'failed', $2, $3, $4, $5, $6, $7)`,
    [`job-${args.chunkId}`, args.chunkId, args.setId, args.dedupeKey, now, now, now]
  );
}

describe('collection debug drawer SQL (real PGlite)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://collection-debug-drawer-queries');
    await migrate(db);

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, embedding_set_id, chunks_count, chunks_processed_at, created_at, updated_at)
       VALUES
         ('fr-complete', 'alpha.md', 'docs/alpha.md', 10, $1, 2, $3, $3, $3),
         ('fr-failed',   'beta.md',  'docs/beta.md',  20, $1, 2, $3, $3, $3),
         ('fr-unchunked','gamma.md', 'docs/gamma.md', 30, $1, NULL, NULL, $3, $3),
         ('fr-other',    'delta.md', 'docs/delta.md', 40, $2, 1, $3, $3, $3)`,
      [SET_ID, OTHER_SET_ID, now]
    );

    // Fully embedded file.
    await insertChunk(db, {
      embedded: true,
      fileRecordId: 'fr-complete',
      id: 'c-complete-0',
      index: 0,
      setId: SET_ID,
    });
    await insertChunk(db, {
      embedded: true,
      fileRecordId: 'fr-complete',
      id: 'c-complete-1',
      index: 1,
      setId: SET_ID,
    });

    // File with one embedded and one unembedded chunk; the unembedded one has
    // a FAILED embed job recorded under the `embed:`-prefixed dedupe key.
    await insertChunk(db, {
      embedded: true,
      fileRecordId: 'fr-failed',
      id: 'c-failed-0',
      index: 0,
      setId: SET_ID,
    });
    await insertChunk(db, {
      embedded: false,
      fileRecordId: 'fr-failed',
      id: 'c-failed-1',
      index: 1,
      setId: SET_ID,
    });
    await insertFailedEmbedJob(db, {
      chunkId: 'c-failed-1',
      // The exact shape `buildEmbedJobDedupeKey` emits — the one that broke
      // `split_part(dedupe_key, ':', 1)`.
      dedupeKey: 'embed:c-failed-1:set-primary:text-embedding-3-small',
      setId: SET_ID,
    });

    // A chunk in the target set whose only failure belongs to ANOTHER set.
    await insertChunk(db, {
      embedded: true,
      fileRecordId: 'fr-complete',
      id: 'c-cross-set',
      index: 2,
      setId: SET_ID,
    });
    await insertFailedEmbedJob(db, {
      chunkId: 'c-cross-set',
      dedupeKey: 'embed:c-cross-set:set-other:text-embedding-3-small',
      setId: OTHER_SET_ID,
    });
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('chunks for a file', () => {
    it('parses and projects dimensions without returning the vector', async () => {
      const res = await db.query<ChunkRow>(CHUNKS_FOR_FILE_SQL, ['fr-complete', SET_ID, 50, 0]);

      expect(res.rows).toHaveLength(3);
      const first = res.rows[0];
      expect(first?.id).toBe('c-complete-0');
      expect(first?.hasEmbedding).toBe(true);
      expect(first?.embeddingDimensions).toBe(3);
      expect(first?.content).toBe('body of c-complete-0');
      expect(first).not.toHaveProperty('embedding');
    });

    it('flags a chunk whose embed job failed, under the embed:-prefixed dedupe key', async () => {
      const res = await db.query<ChunkRow>(CHUNKS_FOR_FILE_SQL, ['fr-failed', SET_ID, 50, 0]);

      const failed = res.rows.find((row) => row.id === 'c-failed-1');
      // This is the assertion the split_part version got wrong: it resolved the
      // chunk id to the literal 'embed' and reported `failed: false`.
      expect(failed?.failed).toBe(true);
      expect(failed?.hasEmbedding).toBe(false);
      expect(failed?.embeddingDimensions).toBe(0);

      expect(res.rows.find((row) => row.id === 'c-failed-0')?.failed).toBe(false);
    });

    it('ignores a failure recorded against a different embedding set', async () => {
      const res = await db.query<ChunkRow>(CHUNKS_FOR_FILE_SQL, ['fr-complete', SET_ID, 50, 0]);

      expect(res.rows.find((row) => row.id === 'c-cross-set')?.failed).toBe(false);
    });

    it('honors LIMIT/OFFSET paging in chunk-index order', async () => {
      const page0 = await db.query<ChunkRow>(CHUNKS_FOR_FILE_SQL, ['fr-complete', SET_ID, 2, 0]);
      const page1 = await db.query<ChunkRow>(CHUNKS_FOR_FILE_SQL, ['fr-complete', SET_ID, 2, 2]);

      expect(page0.rows.map((r) => r.chunkIndex)).toEqual([0, 1]);
      expect(page1.rows.map((r) => r.chunkIndex)).toEqual([2]);
    });
  });

  describe('incomplete files', () => {
    it('parses and lists only files that are not fully embedded, scoped to the set', async () => {
      const res = await db.query<IncompleteRow>(INCOMPLETE_FILES_SQL, [SET_ID, 200]);
      const ids = res.rows.map((row) => row.id);

      expect(ids).toContain('fr-failed');
      // Never chunked => still pending.
      expect(ids).toContain('fr-unchunked');
      // Fully embedded => absent.
      expect(ids).not.toContain('fr-complete');
      // Belongs to another collection => absent.
      expect(ids).not.toContain('fr-other');
    });

    it('counts queue failures per file through the first-class columns', async () => {
      const res = await db.query<IncompleteRow>(INCOMPLETE_FILES_SQL, [SET_ID, 200]);
      const failedFile = res.rows.find((row) => row.id === 'fr-failed');

      expect(failedFile?.failedChunksCount).toBe(1);
      expect(failedFile?.chunksCount).toBe(2);
      expect(failedFile?.embeddedChunksCount).toBe(1);
      expect(failedFile?.chunksProcessed).toBe(true);
      // Failures sort first, so the genuinely-failed file leads the list.
      expect(res.rows[0]?.id).toBe('fr-failed');
    });

    it('reports an unchunked file as pending with zero counts, not as failed', async () => {
      const res = await db.query<IncompleteRow>(INCOMPLETE_FILES_SQL, [SET_ID, 200]);
      const unchunked = res.rows.find((row) => row.id === 'fr-unchunked');

      expect(unchunked?.chunksCount).toBe(0);
      expect(unchunked?.failedChunksCount).toBe(0);
      expect(unchunked?.chunksProcessed).toBe(false);
    });
  });
});
