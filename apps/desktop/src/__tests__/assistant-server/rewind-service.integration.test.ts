/**
 * Conversation Rewind core invariants (BST-1115 W5 T3; snapshot engine
 * BST-1164 W7 T3).
 *
 * REAL PGlite + REAL filesystem + REAL shadow git; only the reindex seam is a
 * probe. Turn boundaries are seeded exactly the way production records them
 * (`seedTurnStartSnapshots`), and every "turn edit" is a DIRECT `fs` write —
 * under the snapshot engine there is no journal row to distinguish a tool
 * edit from a shell side effect, which is the point of the swap.
 *
 * MUTATION-VERIFIED (destructive seam; each mutation was applied to the
 * implementation, the named test observed to FAIL, and the mutation
 * reverted — see the task report):
 * - Swapping `computeRestorePlan(turnStartOid, preRevertOid)`'s argument
 *   order in `executeSnapshotRestore` fails "restores the target turn-start
 *   snapshot" (the apply "restores" the current state instead).
 * - Inverting the drift comparison in `scanPreviewDrift`
 *   (`!==` → `===`) fails "one drifted path blocks the WHOLE apply" (the
 *   hand edit sails through unnamed) and floods the clean-apply tests with
 *   phantom conflicts.
 * - Treating a missing fingerprint as "no conflicts" instead of refusing in
 *   `applyRewindLocked` fails "refuses a files-mode apply that has no
 *   recorded preview".
 * - Dropping the `insertSnapshot` call in `executeSnapshotRestore` fails
 *   "records exactly one pre-revert snapshot row per restored root" (the
 *   pairing assertion throws) — and dropping the assertion TOO fails the
 *   same test's explicit ledger count.
 * - Making `resolveFilesCoverage` return `covered` with zero roots for a
 *   thread with no snapshot rows fails "offers conversation-only with a
 *   visible refusal for a pre-snapshot turn".
 */

import fsPromises from 'node:fs/promises';
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
import {
  applyRewind,
  finalizeThreadRewinds,
  redoRewind,
  rewindToMessage,
} from '../../assistant-server/rewind-service';
import {
  absolutePathFor,
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

const ROOT_ID = 'root-main';

let fixture: RewindFixture;
let probe: ReindexProbe;
let harness: SnapshotHarness;
let deps: RewindServiceDeps;

function root(): string {
  const rootPath = fixture.rootPaths[ROOT_ID];
  if (!rootPath) {
    throw new Error('fixture root missing');
  }
  return rootPath;
}

/**
 * Two turns, two runs. The run a message triggers starts BEFORE that message is
 * persisted (the renderer creates the run row on send; Mastra saves the message
 * during the request) and finishes AFTER that turn's assistant message — which
 * is why the range anchors the TARGET message against `completed_at`. See
 * `resolveRewindRunRange`.
 */
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

/**
 * The standard file history most tests build on: turn 1 (run-1) edits a.txt
 * v0→v1 and b.txt b0→b1; turn 2 (run-2) edits a.txt v1→v2. Both boundaries
 * are snapshotted the way production would.
 */
async function seedTwoTurnFileHistory(): Promise<void> {
  await writeDiskFile(root(), '/a.txt', 'v0');
  await writeDiskFile(root(), '/b.txt', 'b0');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
  await writeDiskFile(root(), '/a.txt', 'v1');
  await writeDiskFile(root(), '/b.txt', 'b1');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-2' });
  await writeDiskFile(root(), '/a.txt', 'v2');
}

async function tombstoneRows(): Promise<
  { messageId: string; revertId: string | null; rewindId: string }[]
> {
  const result = await fixture.db.query<{
    messageId: string;
    revertId: string | null;
    rewindId: string;
  }>(
    `SELECT message_id AS "messageId", rewind_id AS "rewindId", revert_id AS "revertId"
     FROM brainstrike_assistant_message_tombstones
     ORDER BY message_id ASC`
  );
  return result.rows;
}

async function snapshotRowsByKind(
  kind: string
): Promise<{ commitOid: string; runId: string | null }[]> {
  const result = await fixture.db.query<{ commitOid: string; runId: string | null }>(
    `SELECT commit_oid AS "commitOid", run_id AS "runId"
     FROM brainstrike_workspace_snapshots
     WHERE kind = $1
     ORDER BY id ASC`,
    [kind]
  );
  return result.rows;
}

/**
 * Stand-in for the production hard-delete seam. Production passes
 * `PgliteMemoryStore.deleteMessages` (Mastra's own storage API); this does the
 * same thing against the fixture database so the "what does the thread look
 * like afterwards" assertions are real rather than asserted over a spy.
 */
async function deleteMessagesFrom(messageIds: readonly string[]): Promise<void> {
  await fixture.db.query('DELETE FROM mastra_messages WHERE id = ANY($1::text[])', [
    [...messageIds],
  ]);
}

/** Thread messages that survive AND are not hidden by a tombstone. */
async function visibleMessageIds(): Promise<string[]> {
  const result = await fixture.db.query<{ id: string }>(
    `SELECT messages.id AS "id"
     FROM mastra_messages AS messages
     WHERE messages.thread_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM brainstrike_assistant_message_tombstones AS tombstones
         WHERE tombstones.message_id = messages.id
       )
     ORDER BY messages."createdAt" ASC, messages.id ASC`,
    [THREAD_ID]
  );
  return result.rows.map((row) => row.id);
}

/** Generate the preview whose fingerprint the files-mode gate binds. */
async function previewFor(messageId: string): Promise<void> {
  const preview = await rewindToMessage(fixture.db, { messageId, threadId: THREAD_ID }, deps);
  if (!preview.ok) {
    throw new Error(`fixture preview refused: ${preview.message}`);
  }
}

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture({ [ROOT_ID]: await makeTempDir() }, 'rewind-service');
  harness = await createSnapshotHarness(fixture.db);
  deps = rewindDeps(harness, probe);
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — restores the target turn-start snapshot', () => {
  it('restores a multi-run range to the FIRST turn boundary, and redo round-trips', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();
    await previewFor('msg-3');

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Restored to the run-1 turn-start boundary — BOTH turns' edits undone in
    // one restore, no per-record ordering to get wrong.
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b0');
    const outcomes = new Map(result.fileOutcomes.map((outcome) => [outcome.path, outcome.code]));
    expect(outcomes.get('a.txt')).toBe('reverted');
    expect(outcomes.get('b.txt')).toBe('reverted');
    expect(result.rootOutcomes).toEqual([
      expect.objectContaining({
        attempted: 2,
        conflicts: 0,
        failed: 0,
        reverted: 2,
        rootId: ROOT_ID,
      }),
    ]);
    // The reindex seam saw the restored contents — same seam as before the
    // swap, now fed from restore-plan outcomes.
    const restored = probe.calls.filter((call) => call.kind === 'restore');
    expect(restored.map((call) => (call.kind === 'restore' ? call.content : '')).sort()).toEqual([
      'b0',
      'v0',
    ]);

    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v2');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b1');
    if (redone.ok) {
      expect([...redone.restoredMessageIds].sort()).toEqual(['msg-3', 'msg-4', 'msg-5', 'msg-6']);
    }
    expect(await tombstoneRows()).toEqual([]);
  });

  it('records exactly one pre-revert snapshot row per restored root, before the restore', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();
    await previewFor('msg-3');

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.revertId).not.toBeNull();
    // THE PAIRING RULE, checked in the ledger itself: one pre-revert row,
    // grouped under the rewind's revertId — the redo source.
    const preReverts = await snapshotRowsByKind('pre-revert');
    expect(preReverts).toHaveLength(1);
    expect(preReverts[0]?.runId).toBe(result.revertId);
  });
});

describe('applyRewind — the acknowledgment gate binds the preview', () => {
  it('one path drifted after the preview blocks the WHOLE apply until acknowledged', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();
    await previewFor('msg-3');
    // The user hand-edits ONE file AFTER the preview was generated: content
    // the acknowledged preview never showed.
    await writeDiskFile(root(), '/a.txt', 'HAND-EDITED');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('conflicts-unacknowledged');
      expect(refused.conflicts.map((conflict) => conflict.path)).toEqual(['a.txt']);
      expect(refused.conflicts[0]?.code).toBe('disk-changed');
      expect(refused.message).toContain('a.txt');
    }
    // NOTHING applied — not the clean file, not the conversation, no snapshot.
    expect(await readDiskFile(root(), '/a.txt')).toBe('HAND-EDITED');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b1');
    expect(await tombstoneRows()).toEqual([]);
    expect(probe.calls).toEqual([]);
    expect(await snapshotRowsByKind('pre-revert')).toEqual([]);

    const applied = await applyRewind(
      fixture.db,
      {
        acknowledgeConflicts: true,
        messageId: 'msg-3',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      },
      deps
    );
    expect(applied.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b0');
    expect((await tombstoneRows()).map((row) => row.messageId)).toEqual([
      'msg-3',
      'msg-4',
      'msg-5',
      'msg-6',
    ]);
    // The acknowledged drift is in the pre-revert snapshot: redo restores it.
    if (!applied.ok) {
      return;
    }
    const redone = await redoRewind(fixture.db, { rewindId: applied.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('HAND-EDITED');
  });

  it('a fresh preview clears the drift: re-preview then apply needs no acknowledgment', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();
    await previewFor('msg-3');
    await writeDiskFile(root(), '/a.txt', 'HAND-EDITED');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(refused.ok).toBe(false);

    // Re-preview: the user is SHOWN the current state (including the hand
    // edit), so applying over it is now informed.
    await previewFor('msg-3');
    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(applied.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
  });

  it('refuses a files-mode apply that has no recorded preview', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('preview-required');
      expect(refused.message).toContain('msg-3');
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v2');
    expect(await tombstoneRows()).toEqual([]);
    expect(probe.calls).toEqual([]);
  });
});

/**
 * The IN-FLIGHT GATE. `MessageRewindAction` hides itself while
 * `thread.isRunning`, but that state lives inside the assistant panel's React
 * tree and the Changes-surface header action is a sibling page that cannot read
 * it. The binding refusal is therefore the main-process one exercised here —
 * it covers BOTH entry points and no renderer can talk past it.
 *
 * Every other test in this file is the negative control: they seed only
 * `'completed'` runs and apply successfully, so a guard that refused
 * unconditionally would turn the file red.
 */
describe('applyRewind — the in-flight run gate', () => {
  it('refuses while a non-terminal run exists and writes nothing, in either mode', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();
    await previewFor('msg-3');
    // The turn the user is CURRENTLY waiting on: row written on send, no
    // terminal status yet.
    await insertRun(fixture.db, {
      id: 'run-3',
      startedAt: '2026-01-01T00:01:00Z',
      status: 'running',
    });

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('run-in-flight');
      expect(refused.conflicts).toEqual([]);
      expect(refused.message).toContain(THREAD_ID);
    }
    // `conversation-only` reaches the same gate: it writes no file, but it
    // would tombstone messages the live run is still appending.
    const refusedConversationOnly = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    expect(refusedConversationOnly.ok === false && refusedConversationOnly.reason).toBe(
      'run-in-flight'
    );

    // NOTHING was applied by either attempt: no tombstone, no file write, no
    // pre-revert snapshot.
    expect(await tombstoneRows()).toEqual([]);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v2');
    expect(probe.calls).toEqual([]);
    expect(await snapshotRowsByKind('pre-revert')).toEqual([]);
  });
});

describe('applyRewind — files scope availability (carried rulings)', () => {
  it('offers conversation-only with a visible refusal for a pre-snapshot turn', async () => {
    await seedTwoTurnThread();
    // Runs exist, but the thread has NO snapshot rows at all: it predates the
    // engine.
    await writeDiskFile(root(), '/a.txt', 'v1');

    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-3', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.filesScope).toEqual({
      available: false,
      message: expect.stringContaining('predates workspace snapshots'),
      reason: 'turn-predates-snapshots',
    });
    expect(preview.view).toBeNull();

    // Files scope refuses with the SAME reason; the journal engine is not a
    // fallback and disk is untouched.
    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('turn-predates-snapshots');
      expect(refused.message).toContain('predates workspace snapshots');
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');

    // Conversation-only remains available.
    const conversationOnly = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    expect(conversationOnly.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
  });

  it('refuses the files scope when the target turn has no turn-start snapshot (capture failed)', async () => {
    await seedTwoTurnThread();
    // The thread HAS snapshot rows — but only for run-2. run-1's capture
    // failed (or predates capture), so the msg-3 range has no baseline.
    await writeDiskFile(root(), '/a.txt', 'v1');
    await seedTurnStartSnapshots(harness, fixture, { runId: 'run-2' });
    await writeDiskFile(root(), '/a.txt', 'v2');

    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-3', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.filesScope).toEqual({
        available: false,
        message: expect.stringContaining('run "run-1"'),
        reason: 'snapshot-missing',
      });
    }

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('snapshot-missing');
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v2');
    expect(await tombstoneRows()).toEqual([]);

    // Rewinding to the COVERED turn still works.
    await previewFor('msg-5');
    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(applied.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
  });
});

describe('applyRewind — tombstone batch identity', () => {
  it('a re-covering rewind leaves the ORIGINAL batch owning the shared rows', async () => {
    await seedTwoTurnThread();

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

    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    // Only the genuinely new messages join the second batch.
    expect(second.tombstonedMessageIds).toEqual(['msg-3', 'msg-4']);

    const rows = await tombstoneRows();
    const byMessage = new Map(rows.map((row) => [row.messageId, row.rewindId]));
    expect(byMessage.get('msg-5')).toBe(first.rewindId);
    expect(byMessage.get('msg-6')).toBe(first.rewindId);
    expect(byMessage.get('msg-3')).toBe(second.rewindId);
    expect(byMessage.get('msg-4')).toBe(second.rewindId);

    // Redoing the newer rewind restores only what IT hid.
    const redone = await redoRewind(fixture.db, { rewindId: second.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect((await tombstoneRows()).map((row) => row.messageId)).toEqual(['msg-5', 'msg-6']);
  });

  it('refuses to redo anything but the newest batch', async () => {
    await seedTwoTurnThread();
    const first = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const refused = await redoRewind(fixture.db, { rewindId: first.rewindId }, deps);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('not-latest-rewind');
    }
    expect(await tombstoneRows()).toHaveLength(4);
  });

  it('orders successive rewind batches when the database clock is identical', async () => {
    await seedTwoTurnThread();
    // NOW() is fixed throughout this real transaction. The older batch owns
    // msg-6, so breaking a timestamp tie by message id chooses the wrong batch.
    const [first, second] = await fixture.db.transaction(async (db) => {
      const older = await applyRewind(
        db,
        { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
        deps
      );
      const newer = await applyRewind(
        db,
        { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
        deps
      );
      return [older, newer] as const;
    });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      return;
    }
    expect(first.tombstonedMessageIds).toEqual(['msg-5', 'msg-6']);
    expect(second.tombstonedMessageIds).toEqual(['msg-3', 'msg-4']);

    const refused = await redoRewind(fixture.db, { rewindId: first.rewindId }, deps);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('not-latest-rewind');
    }
    expect(await tombstoneRows()).toHaveLength(4);

    const redone = await redoRewind(fixture.db, { rewindId: second.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect((await tombstoneRows()).map((row) => row.messageId)).toEqual(['msg-5', 'msg-6']);
    expect(await visibleMessageIds()).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);

    expect((await redoRewind(fixture.db, { rewindId: first.rewindId }, deps)).ok).toBe(true);
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('applyRewind — mode split', () => {
  it('conversation-only writes revert_id NULL, touches no file and takes no snapshot', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.revertId).toBeNull();
    expect(result.fileOutcomes).toEqual([]);
    expect(result.rootOutcomes).toEqual([]);
    for (const row of await tombstoneRows()) {
      expect(row.revertId).toBeNull();
    }
    // Disk untouched, no reindex, and no pre-revert snapshot was taken.
    expect(await readDiskFile(root(), '/a.txt')).toBe('v2');
    expect(probe.calls).toEqual([]);
    expect(await snapshotRowsByKind('pre-revert')).toEqual([]);
  });
});

describe('rewindToMessage — preview', () => {
  it('resolves the snapshot diff view, the fingerprint, and the tombstone set', async () => {
    await seedTwoTurnThread();
    await seedTwoTurnFileHistory();

    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-3', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.range).toEqual({
      fromRunId: 'run-1',
      kind: 'runs',
      runIds: ['run-1', 'run-2'],
    });
    expect(preview.changeset).toEqual({
      fromRunId: 'run-1',
      kind: 'run-range',
      threadId: THREAD_ID,
    });
    expect(preview.tombstoneMessageIds).toEqual(['msg-3', 'msg-4', 'msg-5', 'msg-6']);
    expect(preview.conflicts).toEqual([]);
    expect(preview.filesScope).toEqual({ available: true });
    // The view is the turn-start-vs-worktree snapshot diff: BOTH files, with
    // real per-file line counts (a git-backed source reports totals).
    const files = new Map(preview.view?.files.map((file) => [file.path, file]) ?? []);
    expect([...files.keys()].sort()).toEqual(['a.txt', 'b.txt']);
    expect(files.get('a.txt')?.status).toBe('modified');
    expect(files.get('a.txt')?.rootId).toBe(ROOT_ID);
    expect(preview.view?.totalAdditions).not.toBeNull();
  });

  it('lists a shell-created file as added — the fixture class the journal engine could not see', async () => {
    await seedTwoTurnThread();
    await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
    // Direct fs write mid-turn — an `npm install` lockfile, a build artifact.
    await writeDiskFile(root(), '/package-lock.json', '{ "lock": true }');

    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-3', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.view?.files).toEqual([
      expect.objectContaining({ path: 'package-lock.json', rootId: ROOT_ID, status: 'added' }),
    ]);
  });

  it('rejects an unknown message instead of previewing an empty rewind', async () => {
    await seedTwoTurnThread();
    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-nope', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.reason).toBe('message-not-found');
    }
  });

  it('reports a thread with no runs after the message as an honest empty range', async () => {
    await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:00Z', id: 'solo-1' });
    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'solo-1', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.range).toEqual({ kind: 'none', reason: 'no-runs-after-message' });
      expect(preview.changeset).toBeNull();
      expect(preview.view).toBeNull();
      expect(preview.filesScope).toEqual({ available: true });
    }
  });
});

describe('finalizeThreadRewinds', () => {
  it('hard-deletes through the store seam and clears the sidecar rows', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );

    const deleted: string[][] = [];
    const outcome = await finalizeThreadRewinds(fixture.db, THREAD_ID, {
      deleteMessages: async (ids) => {
        deleted.push([...ids]);
      },
    });

    expect(outcome.finalized).toBe(true);
    expect(deleted).toEqual([['msg-5', 'msg-6']]);
    expect([...outcome.deletedMessageIds].sort()).toEqual(['msg-5', 'msg-6']);
    expect(await tombstoneRows()).toEqual([]);
  });

  it('keeps the tombstones when the store delete fails', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );

    await expect(
      finalizeThreadRewinds(fixture.db, THREAD_ID, {
        deleteMessages: async () => {
          throw new Error('store unavailable');
        },
      })
    ).rejects.toThrow('store unavailable');
    expect(await tombstoneRows()).toHaveLength(2);
  });

  it('is a no-op for a thread with no outstanding rewind', async () => {
    await seedTwoTurnThread();
    const outcome = await finalizeThreadRewinds(fixture.db, THREAD_ID, {
      deleteMessages: async () => {
        throw new Error('must not be called');
      },
    });
    expect(outcome).toEqual({ deletedMessageIds: [], finalized: false, rewindIds: [] });
  });

  // W5 T4b. The trigger is a user send, and two sends can be in flight (a
  // retry after a transport error, a second panel). A second finalization must
  // cost one query and change nothing — never a second delete of ids that are
  // already gone.
  it('is idempotent when fired twice in a row', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    const deleted: string[][] = [];
    const finalizationDeps = {
      deleteMessages: async (ids: readonly string[]): Promise<void> => {
        deleted.push([...ids]);
        await deleteMessagesFrom(ids);
      },
    };

    const first = await finalizeThreadRewinds(fixture.db, THREAD_ID, finalizationDeps);
    const second = await finalizeThreadRewinds(fixture.db, THREAD_ID, finalizationDeps);

    expect(first.finalized).toBe(true);
    expect(second).toEqual({ deletedMessageIds: [], finalized: false, rewindIds: [] });
    expect(deleted).toEqual([['msg-5', 'msg-6']]);
  });

  it('is double-FIRE safe: two concurrent finalizations delete exactly once', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    const deleted: string[][] = [];
    const finalizationDeps = {
      deleteMessages: async (ids: readonly string[]): Promise<void> => {
        deleted.push([...ids]);
        await deleteMessagesFrom(ids);
      },
    };

    const [first, second] = await Promise.all([
      finalizeThreadRewinds(fixture.db, THREAD_ID, finalizationDeps),
      finalizeThreadRewinds(fixture.db, THREAD_ID, finalizationDeps),
    ]);

    // Serialized, so exactly one sees the tombstones. Without the per-thread
    // lock both read the same rows and `deleteMessages` runs twice.
    expect([first.finalized, second.finalized].sort()).toEqual([false, true]);
    expect(deleted).toEqual([['msg-5', 'msg-6']]);
    expect(await tombstoneRows()).toEqual([]);
  });
});

/**
 * W5 T4b — REDO vs FINALIZATION. These are the two ways a batch stops
 * existing, raised by two independent gestures (the toast's Redo, the next
 * send). The contract is that finalization WINS once the send is committed and
 * redo then refuses with a NAMED reason, never a silent no-op and never a file
 * revert over a conversation that no longer exists.
 */
describe('redoRewind vs finalizeThreadRewinds', () => {
  async function applyConversationOnlyRewind(): Promise<string> {
    await seedTwoTurnThread();
    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      deps
    );
    if (!result.ok) {
      throw new Error('fixture rewind was refused');
    }
    return result.rewindId;
  }

  it('refuses a redo of an already-finalized batch with a typed rewind-not-found', async () => {
    const rewindId = await applyConversationOnlyRewind();
    await finalizeThreadRewinds(fixture.db, THREAD_ID, { deleteMessages: deleteMessagesFrom });

    const redone = await redoRewind(fixture.db, { rewindId }, deps);

    expect(redone.ok).toBe(false);
    if (!redone.ok) {
      expect(redone.reason).toBe('rewind-not-found');
      expect(redone.message).toContain(rewindId);
    }
  });

  it('resolves a redo racing a finalization deterministically, in either order', async () => {
    const rewindId = await applyConversationOnlyRewind();

    // Both raised in the same tick. The lock, not the scheduler, decides.
    const [finalization, redone] = await Promise.all([
      finalizeThreadRewinds(fixture.db, THREAD_ID, { deleteMessages: deleteMessagesFrom }),
      redoRewind(fixture.db, { rewindId }, deps),
    ]);

    // Exactly one wins, and the loser says so. The forbidden outcome is BOTH
    // reporting success — a redo that "restored" nothing while the messages
    // were being hard-deleted underneath it.
    expect(finalization.finalized === true && redone.ok === true).toBe(false);
    if (finalization.finalized) {
      expect(redone.ok).toBe(false);
      if (!redone.ok) {
        expect(redone.reason).toBe('rewind-not-found');
      }
      expect(await visibleMessageIds()).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
    } else {
      expect(redone.ok).toBe(true);
      expect(await visibleMessageIds()).toEqual([
        'msg-1',
        'msg-2',
        'msg-3',
        'msg-4',
        'msg-5',
        'msg-6',
      ]);
    }
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('applyRewind — files created during the turn', () => {
  /**
   * A scaffolding turn writes a directory tree with DIRECT fs writes — the
   * shell-side-effect fixture class the journal engine structurally could
   * not pass. The apply must remove every created file AND prune the emptied
   * directories; redo must rebuild all of it.
   */
  it('removes shell-created files and their scaffolded directories, and redo rebuilds them', async () => {
    await seedTwoTurnThread();
    await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
    for (const [index, filePath] of [
      '/app/src/main.tsx',
      '/app/src/components/Button.tsx',
      '/app/package.json',
    ].entries()) {
      await writeDiskFile(root(), filePath, `scaffold ${index}`);
    }
    await previewFor('msg-3');

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(result.ok).toBe(true);
    await expect(fsPromises.stat(absolutePathFor(root(), '/app'))).rejects.toThrow();
    // The root is the boundary, never a prune candidate.
    expect((await fsPromises.stat(root())).isDirectory()).toBe(true);

    if (!result.ok) {
      return;
    }
    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/app/src/components/Button.tsx')).toBe('scaffold 1');
    expect((await fsPromises.stat(absolutePathFor(root(), '/app/src'))).isDirectory()).toBe(true);
  });
});

/**
 * REGRESSION — the destructive defect from the 2026-08-05 live smoke: a turn
 * is not one run (approval resumes mint new run rows), and the OLD anchor rule
 * swept the previous turn's tail runs into the revert, deleting a file an
 * earlier turn created. Under the snapshot engine the restore target is the
 * TARGET TURN's turn-start snapshot, which by definition contains everything
 * earlier turns produced — so the earlier turn's file is restored to its
 * pre-target-turn content, never deleted.
 */
describe('applyRewind — the range never reaches back past the target message', () => {
  async function seedResumedTurnThread(): Promise<void> {
    await insertRun(fixture.db, {
      completedAt: '2026-03-01T00:01:20Z',
      id: 'run-a1',
      startedAt: '2026-03-01T00:00:59Z',
    });
    await insertMessage(fixture.db, { createdAt: '2026-03-01T00:01:00Z', id: 'msg-a' });
    await insertMessage(fixture.db, {
      createdAt: '2026-03-01T00:01:05Z',
      id: 'msg-b',
      role: 'assistant',
    });
    await insertRun(fixture.db, {
      completedAt: '2026-03-01T00:02:00Z',
      id: 'run-a2',
      startedAt: '2026-03-01T00:01:25Z',
    });
    // Turn B: the prompt the user rewinds to, and the run that edits the file.
    await insertRun(fixture.db, {
      completedAt: '2026-03-01T00:03:30Z',
      id: 'run-b1',
      startedAt: '2026-03-01T00:02:59Z',
    });
    await insertMessage(fixture.db, { createdAt: '2026-03-01T00:03:00Z', id: 'msg-c' });
    await insertMessage(fixture.db, {
      createdAt: '2026-03-01T00:03:10Z',
      id: 'msg-d',
      role: 'assistant',
    });
  }

  it('restores a file the PREVIOUS turn created instead of deleting it', async () => {
    await seedResumedTurnThread();
    // Turn A (runs a1+a2) creates the page.
    await seedTurnStartSnapshots(harness, fixture, { runId: 'run-a1' });
    await writeDiskFile(root(), '/page.html', 'the page turn A built');
    // Turn B's boundary CONTAINS turn A's output; turn B then edits it.
    await seedTurnStartSnapshots(harness, fixture, { runId: 'run-b1' });
    await writeDiskFile(root(), '/page.html', 'the page turn B edited');

    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-c', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.range.kind === 'runs' ? preview.range.runIds : []).toEqual(['run-b1']);

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-c', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The file the user asked to keep still exists, with turn A's content.
    expect(result.fileOutcomes.map((outcome) => outcome.code)).toEqual(['reverted']);
    expect(await readDiskFile(root(), '/page.html')).toBe('the page turn A built');
    // Only turn B's messages are hidden — the conversation side was never wrong.
    expect(result.tombstonedMessageIds).toEqual(['msg-c', 'msg-d']);
  });
});
