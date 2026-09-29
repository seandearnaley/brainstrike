/**
 * BST-1163: the stored run↔turn-message link in BOTH rewind range-resolution
 * directions. Timestamp rules cannot separate a resume of turn N from the
 * opening run of turn N+1 (the 2026-08-05 production incident's class); rows
 * carrying `turn_message_id` now group by TURN, while NULL-link legacy rows
 * keep the `completed_at` fallback exactly as before.
 *
 * Real PGlite via the shared rewind fixture. The timeline mirrors the
 * production-incident seed in `rewind-service.integration.test.ts`
 * (`seedResumedTurnThread`), WITH links:
 *
 *   run-a1  turn A opening   started 00:00:59  completed 00:01:20  → msg-a
 *   msg-a   00:01:00 (user)
 *   msg-b   00:01:05 (assistant)
 *   run-a2  turn A RESUME    started 00:01:25  completed 00:02:00  → msg-a
 *   run-b1  turn B opening   started 00:02:59  completed 00:03:30  → msg-c
 *   msg-c   00:03:00 (user)
 *   msg-d   00:03:10 (assistant)
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import {
  resolveRewindMessageForRun,
  resolveRewindRunRange,
  resolveRewindTarget,
} from '../../assistant-server/rewind-repository';
import {
  cleanupTempDirs,
  createRewindFixture,
  insertMessage,
  insertRun,
  makeTempDir,
  type RewindFixture,
  THREAD_ID,
} from './rewind-service-test-support';

afterEach(async () => {
  await cleanupTempDirs();
});

async function seedLinkedResumedTurnThread(databaseName: string): Promise<RewindFixture> {
  const rootPath = await makeTempDir();
  // `createRewindFixture` seeds THREAD_ID's `mastra_threads` row — every run
  // needs that parent, so the shared fixture owns it rather than each suite.
  const fixture = await createRewindFixture({ 'root-1': rootPath }, databaseName);
  const { db } = fixture;
  await insertRun(db, {
    completedAt: '2026-01-01T00:01:20Z',
    id: 'run-a1',
    startedAt: '2026-01-01T00:00:59Z',
    turnMessageId: 'msg-a',
  });
  await insertMessage(db, { createdAt: '2026-01-01T00:01:00Z', id: 'msg-a', role: 'user' });
  await insertMessage(db, { createdAt: '2026-01-01T00:01:05Z', id: 'msg-b', role: 'assistant' });
  await insertRun(db, {
    completedAt: '2026-01-01T00:02:00Z',
    id: 'run-a2',
    startedAt: '2026-01-01T00:01:25Z',
    turnMessageId: 'msg-a',
  });
  await insertRun(db, {
    completedAt: '2026-01-01T00:03:30Z',
    id: 'run-b1',
    startedAt: '2026-01-01T00:02:59Z',
    turnMessageId: 'msg-c',
  });
  await insertMessage(db, { createdAt: '2026-01-01T00:03:00Z', id: 'msg-c', role: 'user' });
  await insertMessage(db, { createdAt: '2026-01-01T00:03:10Z', id: 'msg-d', role: 'assistant' });
  return fixture;
}

async function targetFor(
  db: EditCheckpointDatabase,
  messageId: string
): Promise<Parameters<typeof resolveRewindRunRange>[1]> {
  const target = await resolveRewindTarget(db, THREAD_ID, messageId);
  if (!target) {
    throw new Error(`expected message ${messageId} to resolve`);
  }
  return target;
}

describe('resolveRewindMessageForRun — the stored link (BST-1163)', () => {
  it("a MID-TURN resume run resolves to ITS OWN turn's message, not the next turn's", async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-inverse');
    const handle = db as unknown as EditCheckpointDatabase;

    // The timestamp rule mapped run-a2 → msg-c (the NEXT turn's message);
    // the link closes that documented under-coverage.
    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-a2')).resolves.toBe('msg-a');
    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-a1')).resolves.toBe('msg-a');
    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-b1')).resolves.toBe('msg-c');
  });

  it('a NULL-link legacy run keeps the timestamp fallback', async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-inverse-legacy');
    const handle = db as unknown as EditCheckpointDatabase;
    await insertRun(db, {
      completedAt: '2026-01-01T00:02:10Z',
      id: 'run-legacy',
      startedAt: '2026-01-01T00:01:30Z',
    });

    // Earliest message strictly after started_at 00:01:30 is msg-c — the
    // pre-link behavior, unchanged for unlinked rows.
    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-legacy')).resolves.toBe(
      'msg-c'
    );
  });

  it('the timestamp fallback resolves to a USER message, never an assistant upsert (PR #2291 review)', async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-inverse-role');
    const handle = db as unknown as EditCheckpointDatabase;
    // An assistant snapshot row lands between this legacy run's start and the
    // next user message. Resolving to it would feed the range resolver a
    // boundary that sorts AFTER the turn's own user-message anchor, making
    // the conversation and file halves disagree about the turn.
    await insertMessage(db, {
      createdAt: '2026-01-01T00:02:40Z',
      id: 'msg-assistant-late',
      role: 'assistant',
    });
    await insertRun(db, {
      completedAt: '2026-01-01T00:02:50Z',
      id: 'run-legacy',
      startedAt: '2026-01-01T00:02:30Z',
    });

    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-legacy')).resolves.toBe(
      'msg-c'
    );
  });

  it('a link pointing at a DELETED message falls back to the timestamp rule instead of answering null', async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-inverse-deleted');
    const handle = db as unknown as EditCheckpointDatabase;
    await insertRun(db, {
      completedAt: '2026-01-01T00:02:10Z',
      id: 'run-orphan-link',
      startedAt: '2026-01-01T00:01:30Z',
      turnMessageId: 'msg-gone',
    });

    await expect(resolveRewindMessageForRun(handle, THREAD_ID, 'run-orphan-link')).resolves.toBe(
      'msg-c'
    );
  });
});

/*
 * The `pre-1163 runs table — the COLUMN probe, not just the table probe`
 * block lived here until BST-1651. It ALTERed `turn_message_id` away to prove
 * the information_schema column probe kept a legacy install off 42703. That
 * premise is retired: migration 118 carries
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS turn_message_id`, so the column
 * reaches every upgraded install through the chain before any main-process
 * read can land, and the probe it guarded is gone. NULL-link rows are still
 * covered — by the two `legacy run keeps the ... fallback` cases above and
 * below, which is the case that actually survives.
 */

describe('resolveRewindRunRange — linked runs group by TURN (BST-1163)', () => {
  it('rewinding to a turn boundary includes the whole later turn and excludes the whole earlier one', async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-range');
    const handle = db as unknown as EditCheckpointDatabase;

    const toC = await resolveRewindRunRange(handle, await targetFor(handle, 'msg-c'));
    expect(toC).toEqual({ fromRunId: 'run-b1', kind: 'runs', runIds: ['run-b1'] });

    // Rewinding to turn A covers BOTH its legs and everything later, with the
    // turn's OPENING run as the range anchor (fromRunId feeds the turn-start
    // snapshot lookup).
    const toA = await resolveRewindRunRange(handle, await targetFor(handle, 'msg-a'));
    expect(toA).toEqual({
      fromRunId: 'run-a1',
      kind: 'runs',
      runIds: ['run-a1', 'run-a2', 'run-b1'],
    });
  });

  it("the link EXCLUDES an earlier turn's straggler leg even when the completed_at rule would sweep it in — the incident class timestamps cannot express", async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-range-straggler');
    const handle = db as unknown as EditCheckpointDatabase;
    // A turn-A resume leg whose terminal status write landed LATE — after
    // msg-c was already sent (crash-recovery bookkeeping, clock skew).
    // completed_at (00:03:05) > msg-c.createdAt (00:03:00), so the timestamp
    // rule ALONE would include it in msg-c's revert range and restore turn
    // A's files — deleting work the user did before msg-c (the 2026-08-05
    // incident's over-revert direction). The link pins it to turn A.
    await insertRun(db, {
      completedAt: '2026-01-01T00:03:05Z',
      id: 'run-a3-straggler',
      startedAt: '2026-01-01T00:01:26Z',
      turnMessageId: 'msg-a',
    });

    const toC = await resolveRewindRunRange(handle, await targetFor(handle, 'msg-c'));
    expect(toC).toEqual({ fromRunId: 'run-b1', kind: 'runs', runIds: ['run-b1'] });
  });

  it('a NULL-link legacy run keeps the completed_at fallback inside a mixed thread', async () => {
    const { db } = await seedLinkedResumedTurnThread('turn-link-range-mixed');
    const handle = db as unknown as EditCheckpointDatabase;
    // Legacy row with no link, completed after msg-c: the fallback includes
    // it (pre-link behavior — over-revert risk is exactly why new rows carry
    // the link, but an unlinked row has nothing better to go on).
    await insertRun(db, {
      completedAt: '2026-01-01T00:03:05Z',
      id: 'run-legacy',
      startedAt: '2026-01-01T00:01:30Z',
    });

    const toC = await resolveRewindRunRange(handle, await targetFor(handle, 'msg-c'));
    expect(toC).toEqual({
      fromRunId: 'run-legacy',
      kind: 'runs',
      runIds: ['run-legacy', 'run-b1'],
    });
  });
});
