import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the assistant run-usage table.
 *
 * Consolidates what migration-046/047/069/077/090's suites asserted about this one
 * table. They were four files only because they were authored as four chain
 * steps; the chain collapsed into a single current-schema DDL (ADR-0020), so the
 * table is now one subject.
 *
 * Dropped with those suites: "creates the table / column / index", which the
 * catalog readback in __tests__/fixtures/schema-catalog.snapshot.txt pins
 * exhaustively for every table at once; every `rollback` case, because ADR-0020
 * does not build rollback; and 077's backfill-an-existing-row case, because a
 * greenfield install starts empty.
 *
 * Kept: what a catalog dump cannot show -- whether the CHECKs actually FIRE,
 * whether the closed `run_kind` vocabulary really is closed, and whether the
 * column defaults produce the documented value on insert.
 */
describe('assistant run usage', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertUsage(columns: string, values: string): Promise<void> {
    await db.query(
      `INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens${columns})
       VALUES ${values}`
    );
  }

  it('stores model/provider per row so per-model attribution survives', async () => {
    await insertUsage(
      '',
      `('u1', 'thread-1', 'run-1', 'workspace-a', 'gpt-5.2', 'openai', 100, 50),
       ('u2', 'thread-1', 'run-2', 'workspace-a', 'claude-opus-4-8', 'anthropic', 200, 75)`
    );

    const rows = await db.query<{
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT model, provider, input_tokens, output_tokens
       FROM brainstrike_assistant_run_usage
       WHERE thread_id = 'thread-1'
       ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { input_tokens: 100, model: 'gpt-5.2', output_tokens: 50, provider: 'openai' },
      { input_tokens: 200, model: 'claude-opus-4-8', output_tokens: 75, provider: 'anthropic' },
    ]);

    const totals = await db.query<{ in_total: number | string; out_total: number | string }>(
      `SELECT SUM(input_tokens) AS in_total, SUM(output_tokens) AS out_total
       FROM brainstrike_assistant_run_usage
       WHERE thread_id = 'thread-1'`
    );
    expect(Number(totals.rows[0]?.in_total ?? 0)).toBe(300);
    expect(Number(totals.rows[0]?.out_total ?? 0)).toBe(125);
  });

  it('rejects negative token counts via the CHECK constraint', async () => {
    await expect(
      insertUsage('', `('bad', 't', 'r', 'workspace-a', 'gpt-5.2', 'openai', -1, 0)`)
    ).rejects.toThrow();
  });

  it('rejects negative cache token counts via the CHECK constraint', async () => {
    await expect(
      insertUsage(
        ', cache_read_input_tokens',
        `('neg-1', 't', 'r', 'res', 'm', 'anthropic', 10, 5, -1)`
      )
    ).rejects.toThrow(/check/i);
  });

  it('accepts a null root_id (honest "unattributed")', async () => {
    await insertUsage(
      ', root_id',
      `('u1', 'thread-1', 'run-1', 'workspace-a', 'gpt-5.2', 'openai', 100, 50, 'root-a'),
       ('u2', 'thread-1', 'run-2', 'workspace-a', 'gpt-5.2', 'openai', 200, 75, NULL)`
    );

    const rows = await db.query<{ id: string; root_id: string | null }>(
      'SELECT id, root_id FROM brainstrike_assistant_run_usage ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: 'u1', root_id: 'root-a' },
      { id: 'u2', root_id: null },
    ]);
  });

  it('defaults run_kind to chat on insert', async () => {
    await insertUsage(
      '',
      `('row-post', 't', 'r', 'workspace-a', 'claude-sonnet-5', 'anthropic', 100, 10)`
    );

    const kinds = await db.query<{ run_kind: string }>(
      'SELECT run_kind FROM brainstrike_assistant_run_usage'
    );
    expect(kinds.rows).toEqual([{ run_kind: 'chat' }]);
  });

  it('accepts every attribution kind and rejects unknown kinds (no silent fallback)', async () => {
    for (const kind of [
      'subagent',
      'om-observation',
      'om-reflection',
      'compaction-summary',
    ] as const) {
      await insertUsage(
        ', run_kind',
        `('row-${kind}', 't', 'r', 'workspace-a', 'claude-sonnet-5', 'anthropic', 100, 10, '${kind}')`
      );
    }

    await expect(
      insertUsage(
        ', run_kind',
        `('row-bogus', 't', 'r', 'workspace-a', 'claude-sonnet-5', 'anthropic', 100, 10, 'embedding')`
      )
    ).rejects.toThrow(/check|constraint/i);
  });
});
