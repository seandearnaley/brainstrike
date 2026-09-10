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
 * That matters because Mastra's relations are created LAZILY by their stores
 * and by NO migration — "relation absent" is the NORMAL state for anyone who
 * has never opened the assistant, not a legacy-schema edge. So the
 * missing-relation branch is a live production path.
 *
 * This test builds the production shape (every relation the handler touches
 * present EXCEPT the lazily created Mastra relations) on a real PGlite and
 * asserts the clear actually commits.
 */
import { getMastraResetTables, getResetTables, wasmLoader } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDatabaseMock,
  handlers,
  resetDatabaseIpcHandlerMocks,
} from './ipc-handlers-db-test-fixture';

/**
 * Every migration-created relation `db:clearAll` deletes from.
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
  'brainstrike_assistant_run_errors',
  'brainstrike_assistant_run_outcomes',
  // Per-run experiment treatment records (migration 093, BST-1250).
  'brainstrike_assistant_run_treatments',
  'brainstrike_assistant_task_lists',
  'brainstrike_assistant_edit_checkpoints',
  'brainstrike_assistant_message_parents',
  'brainstrike_assistant_message_tombstones',
  'brainstrike_assistant_compaction_ranges',
  'brainstrike_assistant_tool_projection_rewrites',
  'brainstrike_assistant_thread_groups',
  'brainstrike_assistant_thread_placements',
  // Per-thread workspace snapshots (migration 095, BST-1268).
  'brainstrike_assistant_thread_workspaces',
  'brainstrike_delegated_invocations',
  'brainstrike_delegated_conversations',
  'prompt_items',
  'brainstrike_assistant_tool_output_artifacts',
  'brainstrike_canvas_versions',
  'brainstrike_tool_call_telemetry',
  'brainstrike_token_estimate_calibration',
  'brainstrike_diagnostic_events',
  // Forge PR cache (migration 110, BST-1391).
  'brainstrike_forge_prs',
  // Managed-worktree ledger (migration 109, BST-1390).
  'brainstrike_worktrees',
  'brainstrike_mind_ops',
  // Principal-bound MCP Tasks handles and durable authority epochs (migration 114, BST-1562).
  'brainstrike_mcp_tasks',
  'brainstrike_mcp_task_authorities',
  'brainstrike_thread_message_index',
  'brainstrike_thread_search_state',
  'brainstrike_workspace_snapshots',
] as const;

/**
 * Independent literals are intentional: importing the production schema
 * constants here would let an incorrect constant rename both the reset and its
 * fixture, leaving the real Mastra relation uncleared while the test stayed
 * green. Every Mastra store is lazy, so the fixture must also prove their
 * absence does not abort the reset transaction.
 */
const LAZY_MASTRA_RELATIONS = [
  'mastra_messages',
  'mastra_observational_memory',
  'mastra_resources',
  'mastra_threads',
  'mastra_vectors',
  'mastra_workflow_snapshot',
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
  const result = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
  const rows = result.rows as Array<{ count: string | number }>;
  return Number(rows[0]?.count ?? -1);
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
    await db.exec("INSERT INTO brainstrike_assistant_thread_groups (id) VALUES ('sentinel-group')");
    await db.exec(
      "INSERT INTO brainstrike_assistant_thread_placements (id) VALUES ('sentinel-placement')"
    );
    await db.exec("INSERT INTO brainstrike_assistant_run_errors (id) VALUES ('sentinel')");
    await db.exec(
      "INSERT INTO brainstrike_assistant_message_tombstones (id) VALUES ('sentinel-tombstone')"
    );
    await db.exec("INSERT INTO brainstrike_diagnostic_events (id) VALUES ('sentinel')");
    // The mind op-log sits third-from-last in the delete order, so this
    // sentinel is the deepest "the whole tail committed" probe — and an op-log
    // row surviving a clear is a real product bug in its own right: tombstones
    // for data the clear just destroyed must not reach a fresh database
    // (migration 079, BST-993).
    await db.exec("INSERT INTO brainstrike_mind_ops (id) VALUES ('sentinel-op')");
    getDatabaseMock.mockReturnValue(db as unknown as ReturnType<typeof getDatabaseMock>);
  });

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('commits the clear when the lazy Mastra relations were never created', async () => {
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    // Asserting the message too, so a regression reports the actual Postgres
    // error (`25P02 …transaction is aborted…`) instead of a bare `false`.
    expect(result).toMatchObject({ message: 'Database cleared successfully', success: true });
    // A poisoned transaction rolls back, so a surviving sentinel proves the
    // clear silently undid itself rather than merely reporting an error.
    expect(await countRows('prompt_items')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_placements')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_groups')).toBe(0);
    expect(await countRows('brainstrike_assistant_run_errors')).toBe(0);
    expect(await countRows('brainstrike_assistant_message_tombstones')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
    expect(await countRows('brainstrike_mind_ops')).toBe(0);
  });

  /**
   * The SAME defect, on the ~14 migration-created relations. It is latent today
   * only because every one of those tables is created by a numbered migration
   * that has already run before a clear begins — the tolerance branch is simply
   * unreachable. The moment one is created lazily, or a migration is reordered,
   * "Clear Database" silently rolls the whole thing back.
   *
   * `roots` is dropped rather than a late table on purpose: it is the FIRST
   * optional relation in the handler's delete order, so both sentinels
   * (`prompt_items`, `brainstrike_diagnostic_events`) sit AFTER it and survive
   * only if the transaction was poisoned.
   */
  it('commits the clear when a migration-created optional relation is absent', async () => {
    if (!db) {
      throw new Error('Test database was not created.');
    }
    await db.exec('DROP TABLE roots');
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    expect(result).toMatchObject({ message: 'Database cleared successfully', success: true });
    expect(await countRows('prompt_items')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_placements')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_groups')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
  });

  /**
   * The selection-snapshot block was the one remaining catch in this handler
   * that only LOGGED a non-missing-relation error and never rethrew (recorded as
   * open debt in docs/agents/platform-contracts.md). It could not produce a false
   * success on desktop — the next unwrapped DELETE raises 25P02 — but the message
   * the user got named the aborted transaction instead of the real cause.
   */
  it('surfaces a genuine selection-snapshot failure as itself, not as 25P02', async () => {
    if (!db) {
      throw new Error('Test database was not created.');
    }
    await db.exec(`
      INSERT INTO selection_snapshots (id) VALUES ('snap-1');
      CREATE TABLE clear_fk_probe (
        id text PRIMARY KEY,
        snapshot_id text NOT NULL REFERENCES selection_snapshots(id) ON DELETE NO ACTION
      );
      INSERT INTO clear_fk_probe (id, snapshot_id) VALUES ('probe-1', 'snap-1');
    `);
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/violates foreign key constraint/iu);
    expect(result.message).not.toMatch(/transaction is aborted/iu);
  });

  it('clears every lazy Mastra relation when it exists', async () => {
    if (!db) {
      throw new Error('Test database was not created.');
    }
    for (const table of LAZY_MASTRA_RELATIONS) {
      await db.exec(`CREATE TABLE ${table} (id text primary key)`);
      await db.exec(`INSERT INTO ${table} (id) VALUES ('sentinel')`);
    }
    // The vector reset is deliberately blanket rather than scoped to one
    // embedding model or namespace. Its logical-index metadata sentinel is
    // assistant state too and must disappear from a true fresh start.
    await db.exec(`
      INSERT INTO mastra_vectors (id)
      VALUES ('second-namespace-sentinel'), ('__index_metadata__')
    `);
    const handler = handlers.get('db:clearAll');

    const result = (await handler?.({} as unknown, 'CONFIRM_CLEAR_DATABASE')) as ClearAllResult;

    expect(result).toMatchObject({ success: true });
    for (const table of LAZY_MASTRA_RELATIONS) {
      expect(await countRows(table)).toBe(0);
    }
    expect(await countRows('brainstrike_assistant_thread_placements')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_groups')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
  });
});

/**
 * Drift guard for the ADDITION case the hand-written literals cannot catch: a
 * new migration-created relation entering the reset registry without a fixture
 * entry does not go red — it silently downgrades that table's coverage to the
 * absent-relation branch (exactly how `brainstrike_mind_ops` went unexercised
 * from BST-993 until BST-1115). The registry is imported for ASSERTION only:
 * the fixtures stay independent literals feeding the SQL (see the rationale on
 * LAZY_MASTRA_RELATIONS above), so an incorrect registry rename breaks this
 * equality loudly instead of self-healing both sides.
 */
describe('clear-all fixture drift guard', () => {
  it('PRESENT_RELATIONS matches the migration-created reset registry', () => {
    const lazy = new Set<string>(getMastraResetTables());
    const migrationCreated = getResetTables().filter((table) => !lazy.has(table));
    expect([...PRESENT_RELATIONS].sort()).toEqual([...migrationCreated].sort());
  });

  it('LAZY_MASTRA_RELATIONS matches the lazy Mastra registry', () => {
    expect([...LAZY_MASTRA_RELATIONS].sort()).toEqual([...getMastraResetTables()].sort());
  });
});
