/**
 * The "needs you" projection against REAL PGlite and REAL table shapes.
 *
 * The sibling unit suite asserts substrings of the query text, which cannot
 * catch the class of error this query was corrected for: a
 * `thread_runs.status = 'running'` join is a perfectly well-formed string that
 * would make the projection permanently EMPTY. Only executing the SELECT over
 * seeded rows falsifies that.
 *
 * The database is MIGRATED first: migrations 117/118 own these tables now, and
 * the repository probes for them rather than creating them (BST-1651). Rows are
 * then seeded through the production repository writers (`createThread` →
 * `createThreadRun` → `appendThreadRunEvent`), so parents exist before children
 * by construction: the Mastra threads row before the `thread_runs` row before
 * the `run_events` row, which the FKs require.
 */
import type { AssistantRunEventKind } from '@brainstrike/assistant-contract';
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THREADS_AWAITING_APPROVAL_SQL } from '../hooks/use-threads-awaiting-approval';

const RESOURCE_ID = 'workspace-a';
const OTHER_RESOURCE_ID = 'workspace-b';

let database: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
let repository: AssistantThreadRepository;
let sequence = 0;

/**
 * Seeded `completed`, which is what production records for BOTH legs: a leg
 * that pauses for approval finishes with `finishReason: 'tool-calls'` and every
 * terminal writer stores that as `completed`. Seeding `running` would let a
 * status-correlated query pass this suite while being permanently empty in the
 * real database.
 */
async function seedRun(threadId: string, resourceId: string, runId: string): Promise<void> {
  await repository.createThreadRun({
    id: runId as HostRunId,
    model: 'test-model',
    provider: 'test-provider',
    resourceId,
    runtimeKind: 'browser',
    status: 'completed',
    threadId,
  });
}

async function seedEvent(
  runId: string,
  kind: AssistantRunEventKind,
  toolCallId: string | null,
  /**
   * Explicit `occurred_at`. Defaults to one minute per seeded event, so the
   * seeding order IS the chronological order for every test that does not care.
   * Pass it only to exercise the timestamp boundary itself.
   */
  timestamp?: string
): Promise<void> {
  sequence += 1;
  await repository.appendThreadRunEvent(runId, {
    id: `${runId}-${kind}-${sequence}`,
    kind,
    label: kind,
    ...(toolCallId === null ? {} : { metadata: { toolCallId } }),
    sequence,
    status: kind === 'tool.approval.requested' ? 'running' : 'completed',
    timestamp: timestamp ?? new Date(Date.UTC(2026, 7, 20, 12, sequence)).toISOString(),
  });
}

async function awaitingApprovalThreadIds(resourceId: string): Promise<readonly string[]> {
  const result = await database.query<{ threadId: string }>(THREADS_AWAITING_APPROVAL_SQL, [
    resourceId,
  ]);
  return result.rows.map((row) => row.threadId);
}

beforeEach(async () => {
  sequence = 0;
  database = await wasmLoader.createPGlite('memory://');
  await migrate(database);
  repository = createPgliteAssistantThreadRepository(database as DbHandle);
});

afterEach(async () => {
  await database.close();
});

describe('threads-awaiting-approval query on real PGlite', () => {
  it('returns a thread whose approval pause has no answer', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-pending');
    await seedEvent('run-pending', 'tool.approval.requested', 'call-pending');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  // The load-bearing case. The resume leg mints its OWN runId (and its own
  // thread_runs row), so the answering event carries a DIFFERENT run_id than
  // the pause. Pairing is on toolCallId alone; a run-correlated query would
  // never close this pause.
  it('drops a thread whose pause was answered from a DIFFERENT run', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-paused');
    await seedEvent('run-paused', 'tool.approval.requested', 'call-answered');

    await seedRun(thread.id, RESOURCE_ID, 'run-resume');
    await seedEvent('run-resume', 'tool.completed', 'call-answered');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  // THE PRODUCER ORDERING, and the reason an answer must POSTDATE its pause.
  // Mastra's approval gate runs INSIDE `toolCallStep`, i.e. after the model's
  // `tool-call` part has already streamed — so the PAUSING leg emits
  // `tool.started` for this very `toolCallId` BEFORE the pause. Pinned against
  // the live Mastra loop in
  // `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`
  // ('tool.started' then 'tool.approval.requested'). Without the guard every
  // pause is instantly answered by its own pre-pause event and the "needs you"
  // glyph never lights for anyone.
  //
  // The guard used to be a same-RUN exclusion, which closed this case but not
  // the two-gated-call one below: a call whose gate is reached a leg later has
  // its pre-pause start on a DIFFERENT run than its pause.
  it('keeps a pause whose OWN run already emitted tool.started for that call', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-prepause');
    await seedEvent('run-prepause', 'tool.started', 'call-prepause');
    await seedEvent('run-prepause', 'tool.approval.requested', 'call-prepause');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  // …and the guard is exactly that narrow: an event that POSTDATES the pause is
  // a real answer and still clears the thread, whatever run it came from.
  it('drops that pause once a DIFFERENT run answers the same call', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-prepause');
    await seedEvent('run-prepause', 'tool.started', 'call-prepause');
    await seedEvent('run-prepause', 'tool.approval.requested', 'call-prepause');

    await seedRun(thread.id, RESOURCE_ID, 'run-resume');
    await seedEvent('run-resume', 'tool.completed', 'call-prepause');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  // CLEAR-ON-ANSWER, not clear-on-completion (BST-1440). The different-run
  // `tool.started` seeded below is a PRODUCTION shape, and only became one with
  // that ticket: the approve-resume leg synthesises the suspended step's start
  // chunks (Mastra never replays a resumed step's `tool-call` part) and now
  // routes them through the same tool-lifecycle seam the mainline uses, so it
  // really does emit `tool.started` for the paused `toolCallId`. Before that,
  // the producer emitted no such event and this row pinned nothing — the glyph
  // cleared only when the approved tool FINISHED.
  //
  // The emission is asserted against the live @mastra/core approval loop in
  // `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`
  // ("The OTHER half of the producer->projection contract"). The different RUN
  // is structural: approve dispatches a NEW request, so `createThreadRunId`
  // mints a new `thread_runs` row for the resume leg.
  //
  // That different-run `tool.started` alone is enough to clear the obligation —
  // the user has answered even though the tool has not finished.
  it('drops that pause on a DIFFERENT run tool.started alone', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-prepause');
    await seedEvent('run-prepause', 'tool.started', 'call-prepause');
    await seedEvent('run-prepause', 'tool.approval.requested', 'call-prepause');

    await seedRun(thread.id, RESOURCE_ID, 'run-resume');
    await seedEvent('run-resume', 'tool.started', 'call-prepause');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  /**
   * TWO gated calls in ONE step — the shape that breaks a purely `run_id`-shaped
   * ordering guard, and the reason this query orders on `occurred_at`.
   *
   * Every row below is a PRODUCTION shape, observed on the live @mastra/core
   * loop and pinned there by
   * `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`
   * ("PAUSES ONE CALL AT A TIME"). Mastra's `foreach(toolCallStep)` is
   * sequential, so with two gated calls in one step it pauses on A alone; B's
   * `tool-call` part has ALREADY streamed, so leg 1 emits `tool.started` for
   * BOTH. Approving A resumes, A runs, and then B reaches its own gate and
   * pauses on leg 2.
   *
   * So B's pre-pause `tool.started` is on leg 1 while B's pause row is on
   * leg 2 — DIFFERENT runs. The same-run exclusion alone therefore cannot
   * exclude it, and B's own pre-pause start would answer B's pause: approving A
   * would silently take the "needs you" glyph dark while B is genuinely still
   * waiting for the user. `occurred_at` is what actually carries the ordering
   * across legs.
   */
  it('keeps the thread lit when a SECOND gated call pauses on the resume leg', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-leg-1');
    await seedEvent('run-leg-1', 'tool.started', 'call-a');
    await seedEvent('run-leg-1', 'tool.started', 'call-b');
    await seedEvent('run-leg-1', 'tool.approval.requested', 'call-a');

    await seedRun(thread.id, RESOURCE_ID, 'run-leg-2');
    await seedEvent('run-leg-2', 'tool.started', 'call-a');
    await seedEvent('run-leg-2', 'tool.approval.requested', 'call-b');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  /** ...and answering B on a third leg finally clears the thread. */
  it('drops it once the SECOND call is answered too', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-leg-1');
    await seedEvent('run-leg-1', 'tool.started', 'call-a');
    await seedEvent('run-leg-1', 'tool.started', 'call-b');
    await seedEvent('run-leg-1', 'tool.approval.requested', 'call-a');

    await seedRun(thread.id, RESOURCE_ID, 'run-leg-2');
    await seedEvent('run-leg-2', 'tool.started', 'call-a');
    await seedEvent('run-leg-2', 'tool.approval.requested', 'call-b');

    await seedRun(thread.id, RESOURCE_ID, 'run-leg-3');
    await seedEvent('run-leg-3', 'tool.started', 'call-b');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  /**
   * The same two-gated-call thread under the PRE-BST-1440 producer, where the
   * resume leg emitted no `tool.started` at all. This is the evidence that the
   * dark-signal defect PREDATES that change rather than being introduced by it:
   * run against the old `run_id`-shaped guard, this seed returned `[]` — B's
   * own leg-1 `tool.started` answered B's leg-2 pause the moment
   * `tool.completed` cleared A's. BST-1440 changed only WHEN it surfaced
   * (approve-time instead of A-completion-time), never whether.
   */
  it('keeps it lit under the pre-BST-1440 producer shape too', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-leg-1');
    await seedEvent('run-leg-1', 'tool.started', 'call-a');
    await seedEvent('run-leg-1', 'tool.started', 'call-b');
    await seedEvent('run-leg-1', 'tool.approval.requested', 'call-a');

    // Pre-BST-1440 the resume leg emitted NO tool.started at all.
    await seedRun(thread.id, RESOURCE_ID, 'run-leg-2');
    await seedEvent('run-leg-2', 'tool.completed', 'call-a');
    await seedEvent('run-leg-2', 'tool.approval.requested', 'call-b');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  /**
   * THE TIE, which is the ordinary case rather than a corner.
   *
   * `occurred_at` is milliseconds (`toISOString`), and a pre-pause
   * `tool.started` and the pause it precedes are emitted back-to-back by the
   * same producer — so sharing a millisecond is normal, not exotic. The guard
   * is strict `>`, so a tie is NOT an answer, which is exactly what that start
   * must be. It is also the safe direction in general: it keeps an obligation
   * lit rather than silently dropping one, and a real answer follows human
   * deliberation so it can never tie.
   */
  it('does not treat an answer kind sharing the pause timestamp as an answer', async () => {
    const sameMs = '2026-08-20T12:30:00.000Z';
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-tie');
    await seedEvent('run-tie', 'tool.started', 'call-tie', sameMs);
    await seedEvent('run-tie', 'tool.approval.requested', 'call-tie', sameMs);

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  // …and one millisecond later IS an answer, so the boundary is `>` and not
  // `>=`-with-slack. Without this pair, a guard that never matched anything
  // would pass the test above.
  it('treats an answer one millisecond after the pause as an answer', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-tie-plus');
    await seedEvent(
      'run-tie-plus',
      'tool.approval.requested',
      'call-tie',
      '2026-08-20T12:30:00.000Z'
    );
    await seedEvent('run-tie-plus', 'tool.completed', 'call-tie', '2026-08-20T12:30:00.001Z');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  it('does not let an answer for a DIFFERENT toolCallId resolve the pause', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-paused');
    await seedEvent('run-paused', 'tool.approval.requested', 'call-pending');
    await seedRun(thread.id, RESOURCE_ID, 'run-other');
    await seedEvent('run-other', 'tool.completed', 'call-unrelated');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });

  it('treats each of the four answer kinds as a resolution', async () => {
    const answered: readonly AssistantRunEventKind[] = [
      'tool.started',
      'tool.completed',
      'tool.failed',
      'tool.resume.unsupported',
    ];
    for (const [index, kind] of answered.entries()) {
      const thread = await repository.createThread(RESOURCE_ID);
      await seedRun(thread.id, RESOURCE_ID, `run-pause-${index}`);
      await seedEvent(`run-pause-${index}`, 'tool.approval.requested', `call-${index}`);
      await seedRun(thread.id, RESOURCE_ID, `run-answer-${index}`);
      await seedEvent(`run-answer-${index}`, kind, `call-${index}`);
    }

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  // A pause nothing could ever answer must not pin the badge forever: with both
  // sides NULL the metadata equality is NULL, so the NOT EXISTS would hold.
  it('excludes a pause row with no toolCallId', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-null');
    await seedEvent('run-null', 'tool.approval.requested', null);

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([]);
  });

  it('never leaks another workspace or another thread into the result', async () => {
    const mine = await repository.createThread(RESOURCE_ID);
    await seedRun(mine.id, RESOURCE_ID, 'run-mine');
    await seedEvent('run-mine', 'tool.approval.requested', 'call-mine');

    const theirs = await repository.createThread(OTHER_RESOURCE_ID);
    await seedRun(theirs.id, OTHER_RESOURCE_ID, 'run-theirs');
    await seedEvent('run-theirs', 'tool.approval.requested', 'call-theirs');

    // Same toolCallId as `mine`, answered in ANOTHER thread: the pause is
    // scoped per thread, so this must not close `mine`.
    const sibling = await repository.createThread(RESOURCE_ID);
    await seedRun(sibling.id, RESOURCE_ID, 'run-sibling');
    await seedEvent('run-sibling', 'tool.completed', 'call-mine');

    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([mine.id]);
    expect(await awaitingApprovalThreadIds(OTHER_RESOURCE_ID)).toEqual([theirs.id]);
  });

  // The two partial indexes exist for THIS query and live in the same
  // bootstrap blob that creates the table (no numbered migration may exist for
  // it). Asserted by existence, not by EXPLAIN: at these row counts the planner
  // correctly prefers a sequential scan, so a plan assertion would be theatre.
  it('bootstraps the partial indexes that serve this query', async () => {
    // The bootstrap is LAZY — a repository call is what runs it.
    await repository.createThread(RESOURCE_ID);

    const indexes = await database.query<{ indexdef: string; indexname: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = 'brainstrike_assistant_run_events'
         AND indexname LIKE '%approval%'
       ORDER BY indexname`
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'brainstrike_assistant_run_events_approval_answer_at_idx',
      'brainstrike_assistant_run_events_approval_pause_idx',
    ]);
    expect(indexes.rows[1]?.indexdef).toContain("kind = 'tool.approval.requested'::text");
    expect(indexes.rows[0]?.indexdef).toContain('toolCallId');
    // The postdates-the-pause comparison is evaluated on this side, so the
    // answer index carries occurred_at. It replaced a trailing run_id, which
    // encoded the premise that a call's pre-pause start always shares its
    // pause's run — false whenever a step gates two calls (BST-1440).
    expect(indexes.rows[0]?.indexdef).toContain('occurred_at');
    expect(indexes.rows[0]?.indexdef).not.toContain('run_id');
  });

  /**
   * THE UPGRADE, which the test above structurally cannot check.
   *
   * `CREATE INDEX IF NOT EXISTS` keys off the NAME. The answer index changed
   * its trailing column from `run_id` to `occurred_at` (BST-1440), so had it
   * kept its old name, every database created before that change would have
   * silently skipped the new definition — keeping the run_id shape forever,
   * returning correct rows while heap-filtering timestamps on every
   * run_events notify. The suite above builds a FRESH database, which never has
   * the old index, so it would pass throughout.
   *
   * This builds the pre-change state explicitly and then MIGRATES, which is
   * what an upgrading install now does: the renderer bootstrap that used to
   * re-run this DDL on every handle init is gone (BST-1651), so migration 118's
   * `DROP INDEX IF EXISTS` + renamed `CREATE INDEX` is the only upgrade path
   * left.
   */
  it('replaces a pre-existing run_id-shaped answer index instead of skipping it', async () => {
    const upgrading = await wasmLoader.createPGlite('memory://');
    try {
      // A pre-BST-1440 install: `run_events` and the OLD answer index already
      // exist, and migration 118 has never run. Only the index-relevant shape
      // matters here; 118's `CREATE TABLE IF NOT EXISTS` no-ops against it, as
      // it does against the real table.
      await upgrading.exec(`
        CREATE TABLE brainstrike_assistant_run_events (
          id text PRIMARY KEY,
          run_id text NOT NULL,
          resource_id text NOT NULL,
          thread_id text NOT NULL,
          sequence integer NOT NULL,
          kind text NOT NULL,
          status text NOT NULL,
          label text NOT NULL,
          detail text,
          duration_ms integer,
          metadata jsonb,
          occurred_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX brainstrike_assistant_run_events_approval_answer_idx
          ON brainstrike_assistant_run_events (resource_id, thread_id, (metadata->>'toolCallId'), run_id)
          WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');
      `);

      await migrate(upgrading);

      const names = await upgrading.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'brainstrike_assistant_run_events'
           AND indexname LIKE '%approval_answer%'
         ORDER BY indexname`
      );

      // The old shape is GONE, not merely shadowed: leaving it would keep paying
      // its write cost on the hottest table in the schema for no read benefit.
      expect(names.rows.map((row) => row.indexname)).toEqual([
        'brainstrike_assistant_run_events_approval_answer_at_idx',
      ]);
    } finally {
      await upgrading.close();
    }
  });

  // The correction this query exists for: a paused leg is recorded
  // `status = 'completed'` (finishReason 'tool-calls'), so any predicate on the
  // run row's status would empty the projection.
  it('still returns the thread when the paused run row is completed', async () => {
    const thread = await repository.createThread(RESOURCE_ID);
    await seedRun(thread.id, RESOURCE_ID, 'run-completed');
    await seedEvent('run-completed', 'tool.approval.requested', 'call-pending');
    await repository.completeThreadRun('run-completed', { status: 'completed' });

    const runStatus = await database.query<{ status: string }>(
      'SELECT status FROM brainstrike_assistant_thread_runs WHERE id = $1',
      ['run-completed']
    );
    expect(runStatus.rows[0]?.status).toBe('completed');
    expect(await awaitingApprovalThreadIds(RESOURCE_ID)).toEqual([thread.id]);
  });
});
