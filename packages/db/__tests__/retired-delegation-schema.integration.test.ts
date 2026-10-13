import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db';

const RETIRED_TABLES = [
  'brainstrike_delegated_conversations',
  'brainstrike_delegated_invocations',
  'brainstrike_delegated_tool_decisions',
  'brainstrike_delegated_continuations',
  'brainstrike_delegated_continuation_decisions',
  'brainstrike_delegated_live_decisions',
  'brainstrike_delegated_wakeups',
  'brainstrike_delegation_budgets',
  'brainstrike_delegation_child_budgets',
  'brainstrike_delegation_step_reservations',
];

describe('current schema without the retired PGlite delegation owner', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createMigratedTestDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it('constructs no delegated tables or invocation decorations on live web usage', async () => {
    const tables = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [RETIRED_TABLES]
    );
    expect(tables.rows).toEqual([]);
    const columns = await db.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'brainstrike_assistant_run_usage'`
    );
    const names = columns.rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(['run_id', 'thread_id', 'input_tokens', 'output_tokens'])
    );
    expect(names).not.toContain('delegation_parent_run_id');
    expect(names).not.toContain('delegation_tool_call_id');
    expect(names).not.toContain('continuation_id');
  });
});
