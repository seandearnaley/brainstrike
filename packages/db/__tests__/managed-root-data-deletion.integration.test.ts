import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { deleteManagedRootData } from '../src/managed-cache/apply-managed-cache-batch.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

let db: PGlite;
beforeEach(async () => {
  db = await createMigratedTestDb();
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path) VALUES ('owned', 'path', 'owned', '/actual'), ('other', 'path', 'other', '/other')`
  );
  await db.query(
    `INSERT INTO embedding_sets (id, model_key, model_id, dimensions) VALUES ('one', 'one-key', 'one-model', 3), ('two', 'two-key', 'two-model', 3)`
  );
  for (const [id, root, collection] of [
    ['owned-one', 'owned', 'one'],
    ['owned-two', 'owned', 'two'],
    ['owned-null', 'owned', null],
    ['rootless', null, 'one'],
    ['other-file', 'other', 'one'],
  ]) {
    await db.query(
      `INSERT INTO file_records (id, name, path, root_id, embedding_set_id, content, content_hash, size, token_count) VALUES ($1, $1, $1, $2, $3, 'actual source', 'actual hash', 13, 2)`,
      [id, root, collection]
    );
    await new FileChunkRepository(db).insert({
      chunkIndex: 0,
      chunkSize: 13,
      chunkType: 'sentence',
      content: 'actual source',
      contentHash: 'actual hash',
      createdAt: new Date().toISOString(),
      embeddingSetId: collection,
      fileRecordId: id,
      id: `${id}-chunk`,
      tokenCount: 2,
      updatedAt: new Date().toISOString(),
    });
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, chunk_id, state, lease_token, leased_until, worker_id) VALUES ($1, 'root-delete-fixture', 'embed_chunk', '{}'::jsonb, $2, 'running', 'original-lease', CURRENT_TIMESTAMP + INTERVAL '1 hour', 'original-worker')`,
      [`${id}-job`, `${id}-chunk`]
    );
  }
});
afterEach(async () => {
  await db.close();
});

it('cancels and clears actual queued/running leases before a whole-root cascade across nullable collection membership', async () => {
  await db.query(`UPDATE job_queue SET state = 'queued' WHERE id = 'owned-two-job'`);
  const result = await deleteManagedRootData(db, { paths: ['/actual'], rootId: 'owned' });
  expect(result).toEqual({
    canceledEmbeddingJobCount: 3,
    deletedChunkIds: ['owned-null-chunk', 'owned-one-chunk', 'owned-two-chunk'],
    deletedFileRecordIds: ['owned-null', 'owned-one', 'owned-two'],
  });
  expect((await db.query('SELECT id FROM roots ORDER BY id')).rows).toEqual([{ id: 'other' }]);
  expect((await db.query('SELECT id FROM file_records ORDER BY id')).rows).toEqual([
    { id: 'other-file' },
    { id: 'rootless' },
  ]);
  expect((await db.query('SELECT id FROM file_chunks ORDER BY id')).rows).toEqual([
    { id: 'other-file-chunk' },
    { id: 'rootless-chunk' },
  ]);
  expect(
    (
      await db.query(
        'SELECT id, state, lease_token, worker_id, leased_until IS NULL AS lease_cleared FROM job_queue ORDER BY id'
      )
    ).rows
  ).toEqual([
    {
      id: 'other-file-job',
      lease_cleared: false,
      lease_token: 'original-lease',
      state: 'running',
      worker_id: 'original-worker',
    },
    ...['owned-null-job', 'owned-one-job', 'owned-two-job'].map((id) => ({
      id,
      lease_cleared: true,
      lease_token: null,
      state: 'canceled',
      worker_id: null,
    })),
    {
      id: 'rootless-job',
      lease_cleared: false,
      lease_token: 'original-lease',
      state: 'running',
      worker_id: 'original-worker',
    },
  ]);
  expect(
    (
      await db.query(
        `SELECT canceled_total::text AS count FROM job_queue_metrics WHERE queue = 'root-delete-fixture'`
      )
    ).rows
  ).toEqual([{ count: '3' }]);
});

it('refuses a foreign/replaced ID/path pair without touching canonical records or active job leases', async () => {
  await expect(
    deleteManagedRootData(db, { paths: ['/replacement'], rootId: 'owned' })
  ).rejects.toThrow('matched no captured root');
  await expect(
    deleteManagedRootData(db, { paths: ['/actual'], rootId: 'unowned' })
  ).rejects.toThrow('matched no captured root');
  expect((await db.query(`SELECT id FROM file_records WHERE root_id = 'owned'`)).rows).toHaveLength(
    3
  );
  expect(
    (await db.query(`SELECT state, lease_token FROM job_queue WHERE id = 'owned-one-job'`)).rows
  ).toEqual([{ lease_token: 'original-lease', state: 'running' }]);
});

it('rolls back job cancellation and cascade together when PG rejects the root delete', async () => {
  await db.exec(
    `CREATE FUNCTION refuse_root_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Root delete rejected'; END $$; CREATE TRIGGER refuse_root_delete BEFORE DELETE ON roots FOR EACH ROW EXECUTE FUNCTION refuse_root_delete();`
  );
  await expect(deleteManagedRootData(db, { paths: ['/actual'], rootId: 'owned' })).rejects.toThrow(
    'Root delete rejected'
  );
  expect((await db.query(`SELECT id FROM file_records WHERE root_id = 'owned'`)).rows).toHaveLength(
    3
  );
  expect(
    (await db.query(`SELECT state, lease_token FROM job_queue WHERE id = 'owned-one-job'`)).rows
  ).toEqual([{ lease_token: 'original-lease', state: 'running' }]);
  expect(
    (
      await db.query(
        `SELECT canceled_total::text AS count FROM job_queue_metrics WHERE queue = 'root-delete-fixture'`
      )
    ).rows
  ).toEqual([]);
});
