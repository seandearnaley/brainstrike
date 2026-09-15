/**
 * BST-1162: the startup reaper for orphaned `running` thread-run rows.
 *
 * A row stuck in `running` (app crash/quit mid-run — both status writers die
 * with their process) permanently trips `hasInFlightThreadRun`'s fail-safe
 * refusal, disabling rewind for that thread forever. The reaper's evidence
 * rule is BOOT TIME, not age: at main-process start no assistant stream can
 * have survived, and every run row this boot mints carries
 * `started_at >= bootedAt` (same machine clock), so
 * `status = 'running' AND started_at < bootedAt` is provably dead — a
 * predicate that stays safe even if the sweep races the first renderer send.
 *
 * The gate's refusal semantics are NOT weakened: live runs and
 * unknown-status rows still refuse (mutation-verified below).
 */
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import { hasInFlightThreadRun } from '../../assistant-server/rewind-repository';
import {
  ORPHANED_BACKGROUND_TASK_ERROR,
  ORPHANED_THREAD_RUN_ERROR,
  REAP_CLOCK_SKEW_MARGIN_MS,
  reapOrphanedThreadRuns,
} from '../../assistant-server/thread-run-startup-reaper';
import { readInFlightAssistantWork } from '../../maintenance-admission';
import {
  cleanupTempDirs,
  createRewindFixture,
  insertRun,
  makeTempDir,
  RESOURCE_ID,
  THREAD_ID,
} from './rewind-service-test-support';

const BOOTED_AT = new Date('2026-01-02T00:00:00Z');

afterEach(async () => {
  await cleanupTempDirs();
});

async function makeFixtureDb(databaseName: string): Promise<PGlite> {
  const rootPath = await makeTempDir();
  const { db } = await createRewindFixture({ 'root-1': rootPath }, databaseName);
  return db;
}

function asHandle(db: PGlite): EditCheckpointDatabase {
  return db as unknown as EditCheckpointDatabase;
}

async function insertBackgroundTask(
  db: PGlite,
  args: {
    readonly createdAt: string;
    readonly id: string;
    readonly resourceId?: string;
    readonly status: string;
    readonly threadId?: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO mastra_background_tasks
       (id, tool_call_id, tool_name, agent_id, run_id, thread_id, resource_id, status,
        args, retry_count, max_retries, timeout_ms, "createdAt")
     VALUES ($1, $1, 'agent-explore', 'brainstrike-assistant', 'native-run', $2, $3, $4,
             '{}', 0, 0, 60000, $5::timestamptz)`,
    [
      args.id,
      args.threadId ?? THREAD_ID,
      args.resourceId ?? RESOURCE_ID,
      args.status,
      args.createdAt,
    ]
  );
}

describe('reapOrphanedThreadRuns (BST-1162)', () => {
  it('marks a pre-boot running row failed with a visible reason, clearing the rewind gate', async () => {
    const db = await makeFixtureDb('reaper-orphan');
    await insertRun(db, {
      id: 'run-orphan',
      startedAt: '2026-01-01T10:00:00Z',
      status: 'running',
    });
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(true);

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect(report.reaped).toEqual([{ id: 'run-orphan', threadId: THREAD_ID }]);
    const row = await db.query<{
      completedAt: string | null;
      error: string | null;
      status: string;
    }>(
      `SELECT status, error, completed_at::text AS "completedAt"
       FROM brainstrike_assistant_thread_runs WHERE id = 'run-orphan'`
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.error).toBe(ORPHANED_THREAD_RUN_ERROR);
    expect(row.rows[0]?.completedAt).not.toBeNull();
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(false);
  });

  it('NEVER touches a run this boot minted — the gate still refuses a genuinely-live run (mutation guard)', async () => {
    const db = await makeFixtureDb('reaper-live');
    // Minted milliseconds after boot: the renderer's first send racing the
    // fire-and-forget sweep.
    await insertRun(db, {
      id: 'run-live',
      startedAt: '2026-01-02T00:00:00.005Z',
      status: 'running',
    });

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect(report.reaped).toEqual([]);
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(true);
  });

  it('leaves a running row inside the clock-skew margin alone — a backward NTP step must not reap a live run (PR #2292 review)', async () => {
    const db = await makeFixtureDb('reaper-skew-margin');
    // Started 30s "before" boot: indistinguishable from a live run minted
    // after a small backward clock correction, so it stays refused rather
    // than reaped. Real orphans are minutes-to-days old and clear the margin.
    const withinMargin = new Date(BOOTED_AT.getTime() - REAP_CLOCK_SKEW_MARGIN_MS / 2);
    await insertRun(db, {
      id: 'run-skewed-live',
      startedAt: withinMargin.toISOString(),
      status: 'running',
    });

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect(report.reaped).toEqual([]);
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(true);
  });

  it('retains cancellation authority when reaping an old cancelling leg and leaves recent intent active', async () => {
    const db = await makeFixtureDb('reaper-cancelling');
    await insertRun(db, {
      id: 'old-cancelling',
      startedAt: '2026-01-01T10:00:00Z',
      status: 'running',
    });
    await insertRun(db, {
      id: 'old-running',
      startedAt: '2026-01-01T10:00:00Z',
      status: 'running',
    });
    await insertRun(db, {
      id: 'recent-cancelling',
      startedAt: new Date(BOOTED_AT.getTime() - REAP_CLOCK_SKEW_MARGIN_MS / 2).toISOString(),
      status: 'running',
    });
    // The status column is intentionally open text; no schema migration is needed.
    await db.query(`UPDATE brainstrike_assistant_thread_runs SET status = 'cancelling'
      WHERE id IN ('old-cancelling', 'recent-cancelling')`);
    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);
    expect(report.reaped.map(({ id }) => id).sort()).toEqual(['old-cancelling', 'old-running']);
    const { rows } = await db.query<{ id: string; status: string; completedAt: string | null }>(
      `SELECT id, status, completed_at::text AS "completedAt" FROM brainstrike_assistant_thread_runs ORDER BY id`
    );
    expect(rows).toEqual([
      { completedAt: expect.any(String), id: 'old-cancelling', status: 'cancelled' },
      { completedAt: expect.any(String), id: 'old-running', status: 'failed' },
      { completedAt: null, id: 'recent-cancelling', status: 'cancelling' },
    ]);
    // The recent cancellation still owns in-flight settlement, including rewind refusal.
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(true);
  });

  it('leaves terminal rows untouched', async () => {
    const db = await makeFixtureDb('reaper-terminal');
    await insertRun(db, {
      completedAt: '2026-01-01T10:01:00Z',
      id: 'run-done',
      startedAt: '2026-01-01T10:00:00Z',
      status: 'completed',
    });
    await insertRun(db, {
      completedAt: '2026-01-01T11:01:00Z',
      id: 'run-cancelled',
      startedAt: '2026-01-01T11:00:00Z',
      status: 'cancelled',
    });

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect(report.reaped).toEqual([]);
    const rows = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM brainstrike_assistant_thread_runs ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: 'run-cancelled', status: 'cancelled' },
      { id: 'run-done', status: 'completed' },
    ]);
  });

  it("does NOT reap an unknown-status row — the gate's fail-safe posture survives the reaper", async () => {
    const db = await makeFixtureDb('reaper-unknown');
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_runs
         (id, resource_id, thread_id, provider, model, runtime_kind, status,
          started_at, created_at, updated_at)
       VALUES ('run-weird', 'workspace-rewind', $1, 'anthropic', 'test-model', 'hosted',
               'suspended-experimental', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z',
               '2026-01-01T10:00:00Z')`,
      [THREAD_ID]
    );

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect(report.reaped).toEqual([]);
    // Unknown status still counts as in flight — refusing is the fail-safe
    // direction, and the reaper must not silently widen its own mandate.
    expect(await hasInFlightThreadRun(asHandle(db), THREAD_ID)).toBe(true);
  });

  /**
   * BST-1749 review: unpreemptable maintenance (database.md, maintenance
   * admission) skips every pass while any `pending`/`running` background task
   * row exists, in ANY thread. Mastra's own stale-task recovery only runs
   * inside a later run of the SAME thread (its store is thread-scoped), so a
   * crash-stranded row in a thread the user never revisits held VACUUM and the
   * HNSW build off forever. The boot evidence rule clears it; a task this boot
   * created and a task suspended on the user are left alone.
   */
  it('fails pre-boot pending and running background tasks so maintenance admission no longer reads them as in flight', async () => {
    const db = await makeFixtureDb('reaper-background-tasks');
    await insertBackgroundTask(db, {
      createdAt: '2026-01-01T10:00:00Z',
      id: 'task-orphan-pending',
      status: 'pending',
    });
    await insertBackgroundTask(db, {
      createdAt: '2026-01-01T10:00:00Z',
      id: 'task-orphan-running',
      status: 'running',
    });
    await insertBackgroundTask(db, {
      createdAt: '2026-01-02T00:00:00.005Z',
      id: 'task-live',
      status: 'running',
    });
    // The clock-skew margin, from BOTH sides (PR #3206 review). A backward NTP
    // step makes a task this boot created read slightly pre-boot, so anything
    // inside the band survives; the first second past the band is reaped.
    await insertBackgroundTask(db, {
      createdAt: new Date(BOOTED_AT.getTime() - REAP_CLOCK_SKEW_MARGIN_MS / 2).toISOString(),
      id: 'task-inside-margin',
      status: 'running',
    });
    await insertBackgroundTask(db, {
      createdAt: new Date(BOOTED_AT.getTime() - REAP_CLOCK_SKEW_MARGIN_MS - 1000).toISOString(),
      id: 'task-past-cutoff',
      status: 'running',
    });
    // The claim the sweep exists for: it is NOT thread-scoped, because the
    // admission gate it serves reads every thread. A row stranded in a thread
    // the user never revisits is precisely the one Mastra's own thread-scoped
    // recovery can never reach, so a thread or resource predicate here would
    // reinstate the bug.
    await insertBackgroundTask(db, {
      createdAt: '2026-01-01T10:00:00Z',
      id: 'task-foreign-thread',
      resourceId: 'workspace-other',
      status: 'running',
      threadId: 'thread-other',
    });
    await insertBackgroundTask(db, {
      createdAt: '2026-01-01T10:00:00Z',
      id: 'task-suspended',
      status: 'suspended',
    });

    const report = await reapOrphanedThreadRuns(asHandle(db), BOOTED_AT);

    expect([...report.reapedBackgroundTaskIds].sort()).toEqual([
      'task-foreign-thread',
      'task-orphan-pending',
      'task-orphan-running',
      'task-past-cutoff',
    ]);
    await expect(readInFlightAssistantWork(db)).resolves.toEqual({ backgroundTasks: 2, runs: 0 });
    const { rows } = await db.query<{
      completedAt: string | null;
      deliveredAt: string | null;
      error: unknown;
      id: string;
      status: string;
    }>(
      `SELECT id, status, error, "completedAt"::text AS "completedAt", delivered_at::text AS "deliveredAt"
       FROM mastra_background_tasks ORDER BY id`
    );
    const orphanError = { message: ORPHANED_BACKGROUND_TASK_ERROR };
    expect(rows).toEqual([
      // Another thread's orphan is reaped too, and until it is, the global
      // in-flight read below counts it and holds maintenance off.
      {
        completedAt: expect.any(String),
        deliveredAt: null,
        error: orphanError,
        id: 'task-foreign-thread',
        status: 'failed',
      },
      {
        completedAt: null,
        deliveredAt: null,
        error: null,
        id: 'task-inside-margin',
        status: 'running',
      },
      { completedAt: null, deliveredAt: null, error: null, id: 'task-live', status: 'running' },
      // Undelivered on purpose: the thread's next turn delivers the failure once.
      {
        completedAt: expect.any(String),
        deliveredAt: null,
        error: orphanError,
        id: 'task-orphan-pending',
        status: 'failed',
      },
      {
        completedAt: expect.any(String),
        deliveredAt: null,
        error: orphanError,
        id: 'task-orphan-running',
        status: 'failed',
      },
      {
        completedAt: expect.any(String),
        deliveredAt: null,
        error: orphanError,
        id: 'task-past-cutoff',
        status: 'failed',
      },
      {
        completedAt: null,
        deliveredAt: null,
        error: null,
        id: 'task-suspended',
        status: 'suspended',
      },
    ]);
  });

  /**
   * PR #3206 review (C): the background-task sweep runs LAST, after the
   * native-decision repair that predates it. That repair is what stops a dead
   * leg from owning native resume admission, and it used to run unconditionally
   * — so a background-task statement that throws (an absent relation, a lock,
   * anything) must not be able to skip it. The reap is one fire-and-forget
   * caller with no transaction, so ORDER is the whole guarantee.
   */
  it('repairs native decisions BEFORE sweeping background tasks, so a failing sweep cannot skip the repair', async () => {
    const db = await makeFixtureDb('reaper-statement-order');
    // The one failure this statement can plausibly raise on a database that
    // never had the relation; any throw would do.
    await db.exec('DROP TABLE mastra_background_tasks');
    const statements: string[] = [];
    const recording = {
      async query<T = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[]
      ): Promise<{ rows: T[] }> {
        statements.push(sql);
        return await asHandle(db).query<T>(sql, params);
      },
    } satisfies EditCheckpointDatabase;

    await expect(reapOrphanedThreadRuns(recording, BOOTED_AT)).rejects.toMatchObject({
      code: '42P01',
    });

    const decisions = statements.findIndex((sql) =>
      sql.includes('brainstrike_delegated_tool_decisions')
    );
    const backgroundTasks = statements.findIndex((sql) => sql.includes('mastra_background_tasks'));
    // Both continuation repairs belong to the same pre-existing group.
    const continuations = statements.filter((sql) =>
      sql.includes('brainstrike_delegated_continuation')
    ).length;
    expect({ continuations, ranDecisionRepair: decisions >= 0 }).toEqual({
      continuations: 2,
      ranDecisionRepair: true,
    });
    // LAST, not merely "after": the sweep threw here, so it is by construction
    // the final recorded statement. A repair appended below it would fail this.
    expect(backgroundTasks).toBe(statements.length - 1);
  });

  /**
   * NOT a supported input — a FAILURE-MODE pin (BST-1651).
   *
   * Migration 118 owns the run header, and neither runtime can hand this sweep
   * a handle that predates migrations: desktop's `getDatabase()` awaits
   * `migrate()` before it resolves, and web gates the reap behind
   * `schemaReady`. The `DROP` manufactures a state the product cannot enter,
   * only to pin that it surfaces AS ITSELF. The retired `runsTableMissing`
   * report turned exactly this — a database that was never migrated — into an
   * `info` line in main and a benign `{ reaped: [] }` here.
   */
  it('lets an unmigrated database raise 42P01 as itself instead of reporting a benign sweep', async () => {
    const rootPath = await makeTempDir();
    const { db } = await createRewindFixture({ 'root-1': rootPath }, 'reaper-no-table');
    // Remove dependent relations first. Migration 118 creates the timeline
    // together and `run_events` carries a foreign key to the run header, so
    // the only database that lacks the header lacks the timeline too — a bare
    // `DROP TABLE` on the parent alone is refused, and `CASCADE` would hide
    // which relations this case actually means to remove.
    // Migration 127 adds invocation identity as another dependent of the header.
    await db.exec(
      'ALTER TABLE brainstrike_assistant_run_usage DROP CONSTRAINT brainstrike_assistant_run_usage_delegation_fk'
    );
    // Migration 139 adds swarm diagnostics rows that reference the run header.
    await db.exec(
      'DROP TABLE brainstrike_assistant_prompt_manifests; DROP TABLE brainstrike_delegated_wakeups; DROP TABLE brainstrike_delegated_live_decisions'
    );
    await db.exec(
      'DROP TABLE brainstrike_delegated_tool_decisions; DROP TABLE brainstrike_delegated_invocations'
    );
    await db.exec('ALTER TABLE brainstrike_assistant_run_usage DROP COLUMN continuation_id');
    await db.exec(
      'DROP TABLE brainstrike_delegated_continuation_decisions; DROP TABLE brainstrike_delegated_continuations'
    );
    await db.exec('DROP TABLE brainstrike_assistant_run_events');
    await db.exec('DROP TABLE brainstrike_delegation_step_reservations');
    await db.exec('DROP TABLE brainstrike_assistant_thread_runs');

    // The code, never the prose: 42P01 is `undefined_table`. `rejects` also
    // fails loudly if the sweep ever RESOLVES again.
    await expect(reapOrphanedThreadRuns(asHandle(db), BOOTED_AT)).rejects.toMatchObject({
      code: '42P01',
    });
    // Schema ownership stays with migrations: the sweep never creates it.
    const probe = await db.query<{ exists: string | null }>(
      "SELECT to_regclass('brainstrike_assistant_thread_runs')::text AS exists"
    );
    expect(probe.rows[0]?.exists).toBeNull();
  });
});
