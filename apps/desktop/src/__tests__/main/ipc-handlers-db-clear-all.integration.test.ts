/**
 * `db:clearAll` against a REAL PGlite — transaction-abort semantics (BST-558).
 *
 * The mocked `db:clearAll` tests in `ipc-handlers-db.test.ts` stub `tx.query`
 * with `vi.fn()`, which has NO aborted-transaction semantics: a stubbed reject
 * for one statement leaves every later stubbed statement perfectly happy. Real
 * Postgres does not work that way — a statement error (e.g. `42P01 relation
 * does not exist`) puts the enclosing transaction into the ABORTED state, and
 * every subsequent command fails with `25P02 current transaction is aborted,
 * commands ignored until end of transaction block` until ROLLBACK. There are no
 * savepoints anywhere in this repo, so catching the 42P01 does not undo that.
 *
 * That matters because `mastra_workflow_snapshot` is created LAZILY by
 * `PgliteWorkflowsStore.initialize()` and by NO migration — "relation absent"
 * is the NORMAL state for anyone who has never opened the assistant, not a
 * legacy-schema edge. So the missing-relation branch is a live production path.
 *
 * This test builds the production shape (every relation the handler touches
 * present EXCEPT the lazily created one) on a real PGlite and asserts the clear
 * actually commits.
 */
import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDatabaseMock,
  handlers,
  resetDatabaseIpcHandlerMocks,
} from './ipc-handlers-db-test-fixture';

/**
 * Every relation `db:clearAll` deletes from, EXCEPT `mastra_workflow_snapshot`.
 * Column shape is irrelevant here — the handler only issues bare `DELETE FROM`
 * and `SELECT COUNT(*)`, so a single-column stand-in reproduces the exact SQL
 * surface while keeping the fixture readable.
 */
const PRESENT_RELATIONS = [
  'file_chunks',
  'file_records',
  'selection_snapshot_files',
  'selection_snapshots',
  'roots',
  'collection_indexing_stats',
  'embedding_sets',
  'job_queue',
  'brainstrike_assistant_run_usage',
  'brainstrike_assistant_run_outcomes',
  'brainstrike_assistant_task_lists',
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_parents',
  'prompt_items',
  'brainstrike_assistant_tool_output_artifacts',
  'brainstrike_diagnostic_events',
  'brainstrike_thread_message_index',
  'brainstrike_thread_search_state',
] as const;

interface ClearAllResult {
  deletedChunks: number;
  deletedFiles: number;
  message: string;
  success: boolean;
}

let db: Awaited<ReturnType<typeof wasmLoader.createPGlite>> | null = null;

async function countRows(table: string): Promise<number> {
  if (!db) {
    throw new Error('Test database was not created.');
  }
  const result = await db.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${table}`
  );
  return Number(result.rows[0]?.count ?? -1);
}

describe('db:clearAll (real PGlite transaction semantics)', () => {
  beforeEach(async () => {
    await resetDatabaseIpcHandlerMocks();
    db = await wasmLoader.createPGlite(`memory://clear-all-${Date.now()}-${Math.random()}`);
    for (const table of PRESENT_RELATIONS) {
      await db.exec(`CREATE TABLE ${table} (id text primary key)`);
    }
    // Sentinels on both sides of the lazily-created relation in the handler's
    // delete order: prompt_items is cleared BEFORE it, diagnostic events AFTER.
    await db.exec("INSERT INTO prompt_items (id) VALUES ('sentinel')");
    await db.exec("INSERT INTO brainstrike_diagnostic_events (id) VALUES ('sentinel')");
    getDatabaseMock.mockReturnValue(db as unknown as ReturnType<typeof getDatabaseMock>);
  });

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('commits the clear when mastra_workflow_snapshot was never created', async () => {
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    // Asserting the message too, so a regression reports the actual Postgres
    // error (`25P02 …transaction is aborted…`) instead of a bare `false`.
    expect(result).toMatchObject({ message: 'Database cleared successfully', success: true });
    // A poisoned transaction rolls back, so a surviving sentinel proves the
    // clear silently undid itself rather than merely reporting an error.
    expect(await countRows('prompt_items')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
  });

  it('still clears the relation when it does exist', async () => {
    if (!db) {
      throw new Error('Test database was not created.');
    }
    await db.exec(`CREATE TABLE ${MASTRA_WORKFLOW_TABLE} (id text primary key)`);
    await db.exec(`INSERT INTO ${MASTRA_WORKFLOW_TABLE} (id) VALUES ('suspended-run')`);
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    expect(result).toMatchObject({ success: true });
    expect(await countRows(MASTRA_WORKFLOW_TABLE)).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
  });
});
