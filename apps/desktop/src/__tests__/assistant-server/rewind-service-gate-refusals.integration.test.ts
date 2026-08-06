/**
 * Conversation Rewind — destructive-seam refusals (BST-1115 W5; snapshot
 * engine BST-1164 W7 T3).
 *
 * Split out of `rewind-service.integration.test.ts` (which hit the per-file
 * line cap): the refusal paths of the destructive seam, kept together as
 * their own unit. Two journal-era suites died WITH the engine and are
 * deliberately absent, not lost: microsecond revert ordering (a snapshot
 * restore has no per-record order) and `range-already-reverted` (a redone
 * range simply restores again — pinned below as the apply→redo→re-apply
 * round-trip).
 *
 * MUTATION-VERIFIED (each mutation applied, named test observed to fail,
 * mutation reverted — see the task report):
 * - Deleting the tombstone batch even when redo outcomes contain a failure
 *   (dropping the `refuseRedoIncomplete` return) fails "keeps the batch and
 *   the messages hidden when a root conflicts mid-redo".
 * - Passing the FRESH snapshot's own hashes as `planSnapshotRedo`'s
 *   expectation (instead of the turn-start hashes) fails "refuses a redo
 *   over files edited after the rewind" — the gate compares the work-tree
 *   with itself and finds nothing.
 * - Skipping the `tombstoned.length === 0` check in `applyFilesRestore`
 *   fails "refuses a coupled apply whose target messages are all hidden".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => {
    throw new Error('getDatabase must not be called by the rewind service tests');
  }),
}));

import type { RewindServiceDeps } from '../../assistant-server/rewind-service';
import { applyRewind, redoRewind, rewindToMessage } from '../../assistant-server/rewind-service';
import {
  cleanupTempDirs,
  createReindexProbe,
  createRewindFixture,
  createSnapshotHarness,
  insertMessage,
  insertRun,
  makeTempDir,
  type ReindexProbe,
  type RewindFixture,
  readDiskFile,
  rewindDeps,
  type SnapshotHarness,
  seedTurnStartSnapshots,
  THREAD_ID,
  writeDiskFile,
} from './rewind-service-test-support';

const ROOT_A = 'root-a';
const ROOT_B = 'root-b';

let fixture: RewindFixture;
let probe: ReindexProbe;
let harness: SnapshotHarness;
let deps: RewindServiceDeps;

function root(rootId: string): string {
  const rootPath = fixture.rootPaths[rootId];
  if (!rootPath) {
    throw new Error(`fixture root "${rootId}" missing`);
  }
  return rootPath;
}

/** Same two-turn, two-run shape as `rewind-service.integration.test.ts`. */
async function seedTwoTurnThread(): Promise<void> {
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:00Z', id: 'msg-1' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:10Z',
    id: 'msg-2',
    role: 'assistant',
  });
  await insertRun(fixture.db, {
    completedAt: '2026-01-01T00:00:35Z',
    id: 'run-1',
    startedAt: '2026-01-01T00:00:20Z',
  });
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:21Z', id: 'msg-3' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:30Z',
    id: 'msg-4',
    role: 'assistant',
  });
  await insertRun(fixture.db, {
    completedAt: '2026-01-01T00:00:55Z',
    id: 'run-2',
    startedAt: '2026-01-01T00:00:40Z',
  });
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:41Z', id: 'msg-5' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:50Z',
    id: 'msg-6',
    role: 'assistant',
  });
}

/** Two roots, one file each: turn 1 (run-1) edits both, turn 2 edits nothing. */
async function seedTwoRootHistory(): Promise<void> {
  await writeDiskFile(root(ROOT_A), '/a.txt', 'a0');
  await writeDiskFile(root(ROOT_B), '/b.txt', 'b0');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
  await writeDiskFile(root(ROOT_A), '/a.txt', 'a1');
  await writeDiskFile(root(ROOT_B), '/b.txt', 'b1');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-2' });
}

async function previewFor(messageId: string): Promise<void> {
  const preview = await rewindToMessage(fixture.db, { messageId, threadId: THREAD_ID }, deps);
  if (!preview.ok) {
    throw new Error(`fixture preview refused: ${preview.message}`);
  }
}

async function tombstoneRows(): Promise<{ messageId: string; rewindId: string }[]> {
  const result = await fixture.db.query<{ messageId: string; rewindId: string }>(
    `SELECT message_id AS "messageId", rewind_id AS "rewindId"
     FROM brainstrike_assistant_message_tombstones
     ORDER BY message_id ASC`
  );
  return result.rows;
}

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture(
    { [ROOT_A]: await makeTempDir(), [ROOT_B]: await makeTempDir() },
    'rewind-service-gates'
  );
  harness = await createSnapshotHarness(fixture.db);
  deps = rewindDeps(harness, probe);
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — already-tombstoned refusal', () => {
  it('refuses a coupled apply whose target messages are all hidden by an earlier open batch', async () => {
    await seedTwoTurnThread();
    await seedTwoRootHistory();

    const first = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.tombstonedMessageIds).toEqual(['msg-5', 'msg-6']);

    // Same target, now coupled: every message it would hide is ALREADY hidden
    // by `first`, so `insertTombstoneBatch` inserts nothing for this batch.
    await previewFor('msg-5');
    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('already-tombstoned');
    }
    // Nothing was touched: no file write, no reindex call, no pre-revert
    // snapshot row, and the original batch still owns the tombstone rows.
    expect(probe.calls).toEqual([]);
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a1');
    const preReverts = await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM brainstrike_workspace_snapshots WHERE kind = 'pre-revert'`
    );
    expect(Number(preReverts.rows[0]?.count ?? 0)).toBe(0);
    const rows = await tombstoneRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.rewindId).toBe(first.rewindId);
    }
  });
});

describe('applyRewind — a redone range can be rewound again', () => {
  /**
   * Replaces the journal engine's `range-already-reverted` refusal, which
   * existed only because redo left `reverted_at` stamps behind. Snapshots
   * carry no such state: after apply→redo, a FRESH preview and apply simply
   * restore the turn boundary again.
   */
  it('apply → redo → re-preview → apply restores the boundary again', async () => {
    await seedTwoTurnThread();
    await seedTwoRootHistory();
    await previewFor('msg-3');

    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a0');

    const redone = await redoRewind(fixture.db, { rewindId: applied.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a1');

    // The first apply consumed its preview fingerprint: applying again
    // without a fresh preview refuses VISIBLY rather than applying blind.
    const stale = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('preview-required');
    }

    await previewFor('msg-3');
    const reapplied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(reapplied.ok).toBe(true);
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a0');
  });
});

describe('redoRewind — the acknowledgment gate', () => {
  it('refuses a redo over files edited after the rewind, then forces per-path on acknowledgment', async () => {
    await seedTwoTurnThread();
    await seedTwoRootHistory();
    await previewFor('msg-3');
    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    // The user edits a restored file AFTER the rewind: redoing would
    // overwrite work the redo gate must name first.
    await writeDiskFile(root(ROOT_A), '/a.txt', 'post-rewind-work');

    const refused = await redoRewind(fixture.db, { rewindId: applied.rewindId }, deps);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('conflicts-unacknowledged');
      expect(refused.conflicts.map((conflict) => conflict.path)).toEqual(['a.txt']);
      expect(refused.conflicts[0]?.code).toBe('disk-changed');
    }
    // Nothing moved: the edit survives and the messages stay hidden.
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('post-rewind-work');
    expect(await tombstoneRows()).toHaveLength(4);

    const forced = await redoRewind(
      fixture.db,
      { acknowledgeConflicts: true, rewindId: applied.rewindId },
      deps
    );
    expect(forced.ok).toBe(true);
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a1');
    expect(await readDiskFile(root(ROOT_B), '/b.txt')).toBe('b1');
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('redoRewind — partial-failure honesty', () => {
  it('keeps the batch and the messages hidden when a root conflicts mid-redo', async () => {
    await seedTwoTurnThread();
    await seedTwoRootHistory();
    await previewFor('msg-3');
    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a0');
    expect(await readDiskFile(root(ROOT_B), '/b.txt')).toBe('b0');

    // A TOCTOU probe: redo restores roots SEQUENTIALLY (sorted by rootId) and
    // fires the reindex seam per root right after that root's restore. When
    // root A's restore reindexes, an external process overwrites root B's
    // file — AFTER redo's own phase-A scan passed it clean, so this is
    // invisible to the gate and only catchable at the per-path write.
    const toctouProbe: typeof probe = {
      ...probe,
      reindex: async (action) => {
        await probe.reindex(action);
        if (action.kind === 'restore' && action.rootId === ROOT_A) {
          await writeDiskFile(root(ROOT_B), '/b.txt', 'external-edit');
        }
      },
    };

    const redone = await redoRewind(
      fixture.db,
      { rewindId: applied.rewindId },
      { ...deps, reindex: toctouProbe.reindex }
    );

    expect(redone.ok).toBe(false);
    if (!redone.ok) {
      expect(redone.reason).toBe('redo-incomplete');
      expect(redone.message).toContain('b.txt');
    }
    // The successful half actually landed...
    expect(await readDiskFile(root(ROOT_A), '/a.txt')).toBe('a1');
    // ...but the failed half was left exactly as the TOCTOU left it, and the
    // messages STAY HIDDEN rather than reappearing over a partial restore.
    expect(await readDiskFile(root(ROOT_B), '/b.txt')).toBe('external-edit');
    expect(await tombstoneRows()).toHaveLength(4);

    // Put root B back to the state the apply left and retry: root A's plan
    // diffs empty (idempotent no-op) and the batch completes.
    await writeDiskFile(root(ROOT_B), '/b.txt', 'b0');
    const retried = await redoRewind(fixture.db, { rewindId: applied.rewindId }, deps);
    expect(retried.ok).toBe(true);
    expect(await readDiskFile(root(ROOT_B), '/b.txt')).toBe('b1');
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('redoRewind — batches that predate the snapshot engine', () => {
  it('refuses with snapshot-missing and leaves the batch in place', async () => {
    await seedTwoTurnThread();
    // A journal-era files batch: tombstones with a revert_id, but NO
    // pre-revert snapshot rows anywhere (the engine that made it is gone).
    await fixture.db.query(
      `INSERT INTO brainstrike_assistant_message_tombstones (message_id, thread_id, rewind_id, revert_id)
       VALUES ('msg-5', $1, 'legacy-rewind', 'legacy-revert'), ('msg-6', $1, 'legacy-rewind', 'legacy-revert')`,
      [THREAD_ID]
    );

    const redone = await redoRewind(fixture.db, { rewindId: 'legacy-rewind' }, deps);

    expect(redone.ok).toBe(false);
    if (!redone.ok) {
      expect(redone.reason).toBe('snapshot-missing');
      expect(redone.message).toContain('pre-revert snapshots');
    }
    // The messages STAY hidden — deleting the batch would un-hide them over
    // files that were never put back.
    expect(await tombstoneRows()).toHaveLength(2);
  });
});
