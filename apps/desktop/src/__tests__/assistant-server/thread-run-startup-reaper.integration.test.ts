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
  ORPHANED_THREAD_RUN_ERROR,
  REAP_CLOCK_SKEW_MARGIN_MS,
  reapOrphanedThreadRuns,
} from '../../assistant-server/thread-run-startup-reaper';
import {
  cleanupTempDirs,
  createRewindFixture,
  insertRun,
  makeTempDir,
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
    await db.exec('DROP TABLE brainstrike_delegated_invocations');
    await db.exec('DROP TABLE brainstrike_assistant_run_events');
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
