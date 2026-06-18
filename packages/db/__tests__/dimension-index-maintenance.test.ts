import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { wasmLoader } from '../src/wasm-loader.js';

const NOW_ISO = '2026-06-18T14:00:00.000Z';

describe('dimension index maintenance migration', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      `memory://dimension-index-maintenance-${crypto.randomUUID()}`
    );
    await migrate(db);
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
