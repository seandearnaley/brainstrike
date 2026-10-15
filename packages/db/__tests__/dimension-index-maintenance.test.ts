import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../src/queue/job-queue.js';
import {
  listDimensionIndexMaintenance,
  listDimensionIndexSuspensions,
  reconcileSuspendedDimensionIndexMaintenance,
  recoverInterruptedDimensionIndexMaintenanceAtStartup,
  requestDimensionIndexMaintenance,
  runNextDimensionIndexMaintenance,
} from '../src/services/dimension-index-maintenance.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

const NOW_ISO = '2026-06-18T14:00:00.000Z';
const RECENT_ISO = '2026-06-18T14:01:00.000Z';

describe('dimension index maintenance migration', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates durable dimension index maintenance rows keyed by dimension', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_maintenance
         (dimension, state, reason, strategy, requested_at, next_run_at, attempts)
       VALUES (384, 'pending', 'background-indexing-backfill-complete', 'regular', $1, $1, 0)
       ON CONFLICT (dimension) DO UPDATE
         SET state = EXCLUDED.state,
             reason = EXCLUDED.reason,
             strategy = EXCLUDED.strategy,
             requested_at = EXCLUDED.requested_at,
             next_run_at = EXCLUDED.next_run_at`,
      [NOW_ISO]
    );

    const result = await db.query<{
      attempts: number;
      dimension: number;
      state: string;
      strategy: string;
    }>(
      `SELECT dimension, state, strategy, attempts
         FROM embedding_dimension_index_maintenance
        WHERE dimension = 384`
    );

    expect(result.rows).toEqual([
      { attempts: 0, dimension: 384, state: 'pending', strategy: 'regular' },
    ]);
  });

  it('rejects unknown maintenance states and strategies', async () => {
    await expect(
      db.query(
        `INSERT INTO embedding_dimension_index_maintenance
           (dimension, state, reason, strategy, requested_at, next_run_at, attempts)
         VALUES (384, 'blocked', 'background-indexing-backfill-complete', 'regular', $1, $1, 0)`,
        [NOW_ISO]
      )
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO embedding_dimension_index_maintenance
           (dimension, state, reason, strategy, requested_at, next_run_at, attempts)
         VALUES (384, 'pending', 'background-indexing-backfill-complete', 'fallback', $1, $1, 0)`,
        [NOW_ISO]
      )
    ).rejects.toThrow();
  });
});

async function expectMaintenanceRow(
  db: PGlite,
  dimension: number,
  state: string,
  expected: Partial<{
    attempts: number;
    lastError: string | null;
    strategy: string;
  }> = {}
): Promise<void> {
  const result = await db.query<{
    attempts: number;
    last_error: string | null;
    state: string;
    strategy: string;
  }>(
    `SELECT state, strategy, attempts, last_error
       FROM embedding_dimension_index_maintenance
      WHERE dimension = $1`,
    [dimension]
  );

  expect(result.rows[0]).toMatchObject({
    attempts: expected.attempts ?? expect.any(Number),
    state,
    strategy: expected.strategy ?? expect.any(String),
  });
  if ('lastError' in expected) {
    expect(result.rows[0]?.last_error).toBe(expected.lastError);
  }
}

async function expectSuspensionPresent(db: PGlite, dimension: number): Promise<void> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM embedding_dimension_index_suspensions
      WHERE dimension = $1`,
    [dimension]
  );
  expect(Number(result.rows[0]?.count ?? 0)).toBe(1);
}

async function expectSuspensionMissing(db: PGlite, dimension: number): Promise<void> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM embedding_dimension_index_suspensions
      WHERE dimension = $1`,
    [dimension]
  );
  expect(Number(result.rows[0]?.count ?? 0)).toBe(0);
}

describe('dimension index maintenance service', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('reclaims a persisted interrupted build only at startup and preserves its retry history', async () => {
    const dataDir = createPGliteTestDataDir('interrupted-dimension-index');
    // On-disk on purpose: the second boot below reopens this data directory.
    const firstBoot = await createMigratedTestDb({ dataDir });
    try {
      await firstBoot.query(
        `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
         VALUES (384, 'embedding-backfill:set-a', $1)`,
        [NOW_ISO]
      );
      await requestDimensionIndexMaintenance(firstBoot, {
        dimension: 384,
        now: () => new Date(NOW_ISO),
        reason: 'embedding-backfill:set-a',
        strategy: 'regular',
      });
      await firstBoot.query(
        `UPDATE embedding_dimension_index_maintenance
            SET state = 'running', attempts = 2, started_at = $1
          WHERE dimension = 384`,
        [NOW_ISO]
      );
    } finally {
      await firstBoot.close();
    }

    const nextBoot = await wasmLoader.createPGlite(dataDir);
    try {
      const createIndex = vi.fn(async () => undefined);
      const beforeRecovery = await runNextDimensionIndexMaintenance(nextBoot, {
        createIndex,
        maxAttempts: 3,
        now: () => new Date(RECENT_ISO),
        strategy: 'regular',
      });
      expect(beforeRecovery).toMatchObject({ reason: 'no-pending-maintenance', status: 'skipped' });
      expect(createIndex).not.toHaveBeenCalled();

      expect(
        await recoverInterruptedDimensionIndexMaintenanceAtStartup(nextBoot, {
          now: () => new Date(RECENT_ISO),
        })
      ).toBe(1);
      expect(
        await recoverInterruptedDimensionIndexMaintenanceAtStartup(nextBoot, {
          now: () => new Date(RECENT_ISO),
        })
      ).toBe(0);
      const [recovered] = await listDimensionIndexMaintenance(nextBoot);
      expect(recovered).toMatchObject({
        attempts: 2,
        dimension: 384,
        nextRunAt: RECENT_ISO,
        reason: 'embedding-backfill:set-a',
        startedAt: null,
        state: 'pending',
        strategy: 'regular',
      });
      await expectSuspensionPresent(nextBoot, 384);

      const result = await runNextDimensionIndexMaintenance(nextBoot, {
        createIndex,
        maxAttempts: 3,
        now: () => new Date(RECENT_ISO),
        strategy: 'regular',
      });
      expect(result).toMatchObject({ dimension: 384, status: 'completed' });
      expect(createIndex).toHaveBeenCalledTimes(1);
      await expectSuspensionMissing(nextBoot, 384);
    } finally {
      await nextBoot.close();
    }
  });

  it('does not refund an interrupted build that already consumed its final attempt', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (384, 'embedding-backfill:set-a', $1)`,
      [NOW_ISO]
    );
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'embedding-backfill:set-a',
      strategy: 'regular',
    });
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = 'running', attempts = 3, started_at = $1
        WHERE dimension = 384`,
      [NOW_ISO]
    );

    expect(
      await recoverInterruptedDimensionIndexMaintenanceAtStartup(db, {
        now: () => new Date(RECENT_ISO),
      })
    ).toBe(1);
    await expectMaintenanceRow(db, 384, 'pending', { attempts: 3 });

    const createIndex = vi.fn(async () => undefined);
    for (let tick = 0; tick < 2; tick += 1) {
      const result = await runNextDimensionIndexMaintenance(db, {
        createIndex,
        maxAttempts: 3,
        now: () => new Date(RECENT_ISO),
        strategy: 'regular',
      });
      expect(result).toMatchObject({ reason: 'max-attempts', status: 'skipped' });
    }
    expect(createIndex).not.toHaveBeenCalled();
    await expectMaintenanceRow(db, 384, 'pending', { attempts: 3 });
    await expectSuspensionPresent(db, 384);
  });

  it('does not reset a terminal failed suspended build on routine ticks', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (384, 'embedding-backfill:set-a', $1)`,
      [NOW_ISO]
    );
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'embedding-backfill:set-a',
      strategy: 'regular',
    });
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = 'failed', attempts = 3, last_error = 'index build failed'
        WHERE dimension = 384`
    );

    const createIndex = vi.fn(async () => undefined);
    for (let tick = 0; tick < 2; tick += 1) {
      const result = await runNextDimensionIndexMaintenance(db, {
        createIndex,
        maxAttempts: 3,
        now: () => new Date(RECENT_ISO),
        strategy: 'regular',
      });
      expect(result).toMatchObject({ status: 'skipped' });
    }
    expect(createIndex).not.toHaveBeenCalled();
    await expectMaintenanceRow(db, 384, 'failed', {
      attempts: 3,
      lastError: 'index build failed',
    });
    await expectSuspensionPresent(db, 384);
  });

  it('lists active dimension index suspensions for diagnostics', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (768, 'manual-backfill', $1),
              (384, 'background-indexing', $2)`,
      [NOW_ISO, RECENT_ISO]
    );

    await expect(listDimensionIndexSuspensions(db)).resolves.toEqual([
      {
        dimension: 384,
        reason: 'background-indexing',
        suspendedAt: RECENT_ISO,
      },
      {
        dimension: 768,
        reason: 'manual-backfill',
        suspendedAt: NOW_ISO,
      },
    ]);
  });

  it('requests maintenance idempotently and keeps a pending retry visible', async () => {
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = 'failed',
              attempts = 1,
              last_error = 'previous failure'
        WHERE dimension = 384`
    );

    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(RECENT_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });

    const rows = await listDimensionIndexMaintenance(db);
    expect(rows).toMatchObject([
      {
        attempts: 0,
        dimension: 384,
        lastError: 'previous failure',
        state: 'pending',
        strategy: 'regular',
      },
    ]);
  });

  it('resets max-attempt failures so a fresh maintenance request is claimable', async () => {
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });
    await db.query(
      `UPDATE embedding_dimension_index_maintenance
          SET state = 'failed',
              attempts = 3,
              last_error = 'previous max-attempt failure'
        WHERE dimension = 384`
    );

    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(RECENT_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });
    const createIndex = vi.fn(async () => undefined);

    const result = await runNextDimensionIndexMaintenance(db, {
      createIndex,
      maxAttempts: 3,
      now: () => new Date(RECENT_ISO),
      strategy: 'regular',
    });

    expect(result).toMatchObject({ dimension: 384, status: 'completed' });
    expect(createIndex).toHaveBeenCalledTimes(1);
    await expectMaintenanceRow(db, 384, 'succeeded', {
      attempts: 1,
      lastError: null,
      strategy: 'regular',
    });
  });

  it('reconciles orphaned suspensions into pending maintenance rows', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (384, 'embedding-backfill:set-a', $1)`,
      [NOW_ISO]
    );

    const count = await reconcileSuspendedDimensionIndexMaintenance(db, {
      now: () => new Date(RECENT_ISO),
      strategy: 'regular',
    });

    expect(count).toBe(1);
    await expectMaintenanceRow(db, 384, 'pending', { strategy: 'regular' });
  });

  it('skips maintenance while embedding jobs are active', async () => {
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });
    const queue = new JobQueue(db);
    await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId: crypto.randomUUID(), embeddingSetId: 'set-a' },
      queue: 'embeddings',
    });

    const result = await runNextDimensionIndexMaintenance(db, {
      createIndex: vi.fn(),
      now: () => new Date(RECENT_ISO),
      strategy: 'regular',
    });

    expect(result).toMatchObject({ reason: 'active-job-queue', status: 'skipped' });
  });

  it('creates the index then resumes the suspension on success', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (384, 'embedding-backfill:set-a', $1)`,
      [NOW_ISO]
    );
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });
    const createIndex = vi.fn(async () => undefined);

    const result = await runNextDimensionIndexMaintenance(db, {
      createIndex,
      foregroundProbeMaxMs: 30,
      foregroundProbeP95Ms: 20,
      now: () => new Date(RECENT_ISO),
      strategy: 'regular',
    });

    expect(result).toMatchObject({ dimension: 384, status: 'completed' });
    expect(createIndex).toHaveBeenCalledWith({ dimension: 384, strategy: 'regular' });
    await expectSuspensionMissing(db, 384);
    await expectMaintenanceRow(db, 384, 'succeeded', {
      attempts: 1,
      lastError: null,
      strategy: 'regular',
    });
  });

  it('records retryable failure and keeps the suspension when index creation fails', async () => {
    await db.query(
      `INSERT INTO embedding_dimension_index_suspensions (dimension, reason, suspended_at)
       VALUES (384, 'embedding-backfill:set-a', $1)`,
      [NOW_ISO]
    );
    await requestDimensionIndexMaintenance(db, {
      dimension: 384,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'regular',
    });

    const result = await runNextDimensionIndexMaintenance(db, {
      createIndex: vi.fn(async () => {
        throw new Error('hnsw build failed');
      }),
      now: () => new Date(RECENT_ISO),
      retryBackoffMs: 60_000,
      strategy: 'regular',
    });

    expect(result).toMatchObject({
      dimension: 384,
      error: 'hnsw build failed',
      status: 'failed',
    });
    await expectSuspensionPresent(db, 384);
    await expectMaintenanceRow(db, 384, 'pending', {
      attempts: 1,
      lastError: 'hnsw build failed',
      strategy: 'regular',
    });
  });

  it('records the invalid index for the claimed dimension only', async () => {
    await requestDimensionIndexMaintenance(db, {
      dimension: 768,
      now: () => new Date(NOW_ISO),
      reason: 'background-indexing-backfill-complete',
      strategy: 'concurrent',
    });

    const result = await runNextDimensionIndexMaintenance(db, {
      createIndex: vi.fn(async () => {
        throw new Error('concurrent index failed');
      }),
      listInvalidIndexes: vi.fn(async () => [
        {
          indexName: 'idx_file_chunks_emb_hnsw_384',
          isReady: false,
          isValid: false,
        },
        {
          indexName: 'idx_file_chunks_emb_hnsw_768',
          isReady: false,
          isValid: false,
        },
      ]),
      now: () => new Date(RECENT_ISO),
      retryBackoffMs: 60_000,
      strategy: 'concurrent',
    });

    expect(result).toMatchObject({
      dimension: 768,
      error: 'concurrent index failed',
      status: 'failed',
    });

    const rows = await listDimensionIndexMaintenance(db);
    expect(rows).toMatchObject([
      {
        dimension: 768,
        lastInvalidIndexName: 'idx_file_chunks_emb_hnsw_768',
        state: 'pending',
        strategy: 'concurrent',
      },
    ]);
  });
});
