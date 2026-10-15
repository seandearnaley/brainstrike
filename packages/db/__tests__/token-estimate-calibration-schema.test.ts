import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_token_estimate_calibration';

/**
 * Runtime behaviour of the token-estimate calibration table (BST-1205).
 *
 * Was migration-086's suite, plus the CHECK rejections from migration-089's and
 * migration-091's. Dropped: the index-set assertion, pinned
 * exhaustively by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt, and the separate "creates the
 * same table in the production runner" suite -- there is now ONE runner
 * (ADR-0020). Kept: that each count CHECK actually fires, that a well-formed
 * row round-trips, and that the table is registered for Clear/Factory Reset.
 */
describe('token estimate calibration', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertCalibration(columns: string, values: string): Promise<void> {
    await db.query(
      `INSERT INTO ${TABLE}
        (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
         final_step_prompt_tokens${columns})
       VALUES ${values}`
    );
  }

  it('stores a well-formed calibration row', async () => {
    await insertCalibration(
      ', step_count, model_visible_projection_count, occurred_at',
      `('id-1', 'thread-1', 'run-1', 'gpt-5.6-terra', 'openai', 42, 50, 2, 1, NOW())`
    );

    expect((await db.query(`SELECT * FROM ${TABLE}`)).rows).toHaveLength(1);
  });

  it('rejects invalid calibration counts', async () => {
    await expect(
      insertCalibration('', `('bad-estimate', 'thread', 'run', 'model', 'provider', -1, 1)`)
    ).rejects.toThrow(/check constraint/i);
    await expect(
      insertCalibration('', `('bad-final-step', 'thread', 'run', 'model', 'provider', 1, -1)`)
    ).rejects.toThrow(/check constraint/i);
    await expect(
      insertCalibration(
        ', step_count',
        `('bad-step-count', 'thread', 'run', 'model', 'provider', 1, 1, 0)`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      insertCalibration(
        ', model_visible_projection_count',
        `('bad-projection-count', 'thread', 'run', 'model', 'provider', 1, 1, -1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a non-positive resolved budget or prompt baseline', async () => {
    // Was migration-089's and migration-091's suites. Each column is
    // "NULL or > 0": NULL means unresolved, and 0 would read as a real budget
    // of zero tokens.
    for (const column of [
      'resolved_domain_budget_tokens',
      'resolved_transport_budget_tokens',
      'prompt_baseline_tokens',
    ] as const) {
      await expect(
        insertCalibration(
          `, ${column}`,
          `('bad-${column}', 'thread', 'run', 'model', 'provider', 1, 1, 0)`
        )
      ).rejects.toThrow(/check constraint/i);
      // NULL is the "unresolved" case and must stay insertable; a throw here
      // fails the test.
      await insertCalibration(
        `, ${column}`,
        `('null-${column}', 'thread', 'run', 'model', 'provider', 1, 1, NULL)`
      );
    }
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
