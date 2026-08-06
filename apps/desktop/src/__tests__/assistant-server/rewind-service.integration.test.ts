/**
 * Conversation Rewind core invariants (BST-1115, W5 T3).
 *
 * MUTATION-VERIFIED: each `it` below was confirmed to FAIL against a
 * deliberately broken implementation before being accepted (see the task
 * report for the mutation list). A test that passes against a broken
 * implementation is not evidence, and this is the destructive seam.
 *
 * REAL PGlite + REAL filesystem; only the reindex seam is a probe.
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

import { recordEditCheckpoint, sha256Hex } from '../../assistant-server/edit-checkpoint-journal';
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
  insertMessage,
  insertRun,
  makeTempDir,
  RESOURCE_ID,
  type ReindexProbe,
  type RewindFixture,
  readDiskFile,
  restoredContents,
  seedWrite,
  THREAD_ID,
  writeDiskFile,
} from './rewind-service-test-support';

const ROOT_ID = 'root-main';

let fixture: RewindFixture;
let probe: ReindexProbe;

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
 * is why the range anchors the TARGET message against `completed_at` rather
 * than either message against `started_at`. See `resolveRewindRunRange`.
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

async function countJournalRows(runId: string): Promise<number> {
  const result = await fixture.db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_edit_checkpoints WHERE run_id = $1',
    [runId]
  );
  return Number(result.rows[0]?.count ?? 0);
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

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture({ [ROOT_ID]: await makeTempDir() }, 'rewind-service');
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — sequential newest-first ordering', () => {
  it('reverts a file edited in TWO runs newest-first, one revert at a time', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    await seedWrite(fixture, {
      after: 'b1',
      before: 'b0',
      occurredAt: '2026-01-01T00:00:26Z',
      path: '/b.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    await seedWrite(fixture, {
      after: 'v2',
      before: 'v1',
      occurredAt: '2026-01-01T00:00:45Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-2',
    });

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(result.ok).toBe(true);
    // Newest-first: a@45 (v2->v1), then b@26 (b1->b0), then a@25 (v1->v0).
    // Oldest-first would make a@25's conflict check fail against on-disk v2.
    expect(restoredContents(probe)).toEqual(['v1', 'b0', 'v0']);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b0');
    // Sequential, not Promise.all: two reverts must never be in flight at once.
    expect(probe.overlaps).toEqual([]);
  });
});

describe('applyRewind — the acknowledgment gate', () => {
  it('one conflicting file blocks the WHOLE apply: no file, no tombstone, no revert stamp', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    await seedWrite(fixture, {
      after: 'b1',
      before: 'b0',
      occurredAt: '2026-01-01T00:00:26Z',
      path: '/b.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    // The user hand-edits ONE of the two files after the run.
    await writeDiskFile(root(), '/a.txt', 'HAND-EDITED');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('conflicts-unacknowledged');
      expect(refused.conflicts.map((conflict) => conflict.path)).toEqual(['/a.txt']);
      expect(refused.message).toContain('/a.txt');
    }
    // NOTHING applied — not even the clean file, not even the conversation.
    expect(await readDiskFile(root(), '/a.txt')).toBe('HAND-EDITED');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b1');
    expect(await tombstoneRows()).toEqual([]);
    expect(probe.calls).toEqual([]);

    const applied = await applyRewind(
      fixture.db,
      {
        acknowledgeConflicts: true,
        messageId: 'msg-3',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      },
      probe
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
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    const journalBefore = await countJournalRows('run-1');
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
      probe
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
      probe
    );
    expect(refusedConversationOnly.ok === false && refusedConversationOnly.reason).toBe(
      'run-in-flight'
    );

    // NOTHING was applied by either attempt: no tombstone, no file write, no
    // revert stamp, no journal row.
    expect(await tombstoneRows()).toEqual([]);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    expect(probe.calls).toEqual([]);
    expect(await countJournalRows('run-1')).toBe(journalBefore);
    const strays = await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM brainstrike_assistant_edit_checkpoints
       WHERE run_id NOT IN ('run-1', 'run-2')`
    );
    expect(Number(strays.rows[0]?.count ?? 0)).toBe(0);
  });
});

describe('applyRewind — after-capture pairing', () => {
  it('journals every revert under the rewind revertId, and redo replays it', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const revertId = result.revertId;
    expect(revertId).not.toBeNull();
    if (revertId === null) {
      return;
    }

    const captures = await fixture.db.query<{
      beforeContent: string | null;
      captureStatus: string;
      path: string;
      toolName: string;
    }>(
      `SELECT path AS "path", before_content AS "beforeContent",
              capture_status AS "captureStatus", tool_name AS "toolName"
       FROM brainstrike_assistant_edit_checkpoints WHERE run_id = $1`,
      [revertId]
    );
    // The bytes the revert destroyed are captured, or redo has nothing to
    // restore from.
    expect(captures.rows).toHaveLength(1);
    expect(captures.rows[0]?.path).toBe('/a.txt');
    expect(captures.rows[0]?.beforeContent).toBe('v1');
    expect(captures.rows[0]?.captureStatus).toBe('ok');
    expect(captures.rows[0]?.toolName).toBe('brainstrike.rewindRevert');
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');

    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    if (redone.ok) {
      expect([...redone.restoredMessageIds].sort()).toEqual(['msg-3', 'msg-4', 'msg-5', 'msg-6']);
    }
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('applyRewind — partial-failure honesty', () => {
  it('names every unrestorable file by path instead of swallowing it', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    // A retention-expired capture: acknowledging cannot rescue it, so it must
    // still be reported, by path, in the outcomes.
    await writeDiskFile(root(), '/c.txt', 'c1');
    await recordEditCheckpoint(fixture.db, {
      afterExisted: true,
      afterHash: sha256Hex('c1'),
      beforeContent: null,
      beforeExisted: true,
      beforeHash: sha256Hex('c0'),
      beforeSize: 2,
      captureStatus: 'expired',
      occurredAt: new Date('2026-01-01T00:00:26Z'),
      op: 'write',
      path: '/c.txt',
      resourceId: RESOURCE_ID,
      rootId: ROOT_ID,
      runId: 'run-1',
      threadId: THREAD_ID,
      toolName: 'brainstrike.writeWorkspaceFile',
    });

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.conflicts.map((conflict) => conflict.path)).toEqual(['/c.txt']);
      expect(refused.conflicts[0]?.code).toBe('capture-unavailable');
    }

    const applied = await applyRewind(
      fixture.db,
      {
        acknowledgeConflicts: true,
        messageId: 'msg-3',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      },
      probe
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    const byPath = new Map(applied.fileOutcomes.map((outcome) => [outcome.path, outcome]));
    expect(byPath.get('/a.txt')?.code).toBe('reverted');
    expect(byPath.get('/c.txt')?.code).toBe('not_revertible');
    expect(byPath.get('/c.txt')?.message).toBeTruthy();
    expect(applied.rootOutcomes).toEqual([
      expect.objectContaining({ attempted: 2, failed: 1, reverted: 1, rootId: ROOT_ID }),
    ]);
    expect(await readDiskFile(root(), '/c.txt')).toBe('c1');
  });
});

describe('applyRewind — tombstone batch identity', () => {
  it('a re-covering rewind leaves the ORIGINAL batch owning the shared rows', async () => {
    await seedTwoTurnThread();

    const first = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      probe
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.tombstonedMessageIds).toEqual(['msg-5', 'msg-6']);

    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      probe
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
    const redone = await redoRewind(fixture.db, { rewindId: second.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect((await tombstoneRows()).map((row) => row.messageId)).toEqual(['msg-5', 'msg-6']);
  });

  it('refuses to redo anything but the newest batch', async () => {
    await seedTwoTurnThread();
    const first = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      probe
    );
    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      probe
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const refused = await redoRewind(fixture.db, { rewindId: first.rewindId }, probe);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('not-latest-rewind');
    }
    expect(await tombstoneRows()).toHaveLength(4);
  });
});

describe('applyRewind — mode split', () => {
  it('conversation-only writes revert_id NULL, touches no file and journals nothing', async () => {
    await seedTwoTurnThread();
    const originalId = await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    const journalBefore = await countJournalRows('run-1');

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-only', threadId: THREAD_ID },
      probe
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
    // The file is untouched and its journal entry is still un-reverted.
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    expect(probe.calls).toEqual([]);
    expect(await countJournalRows('run-1')).toBe(journalBefore);
    const stamp = await fixture.db.query<{ revertedAt: string | null }>(
      `SELECT reverted_at AS "revertedAt" FROM brainstrike_assistant_edit_checkpoints WHERE id = $1`,
      [originalId]
    );
    expect(stamp.rows[0]?.revertedAt).toBeNull();
    // No journal rows exist outside the seeded runs at all.
    const strays = await fixture.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM brainstrike_assistant_edit_checkpoints
       WHERE run_id NOT IN ('run-1', 'run-2')`
    );
    expect(Number(strays.rows[0]?.count ?? 0)).toBe(0);
  });
});

describe('rewindToMessage — preview', () => {
  it('reuses the run-range ChangesetView and lists the messages that would be hidden', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    await seedWrite(fixture, {
      after: 'v2',
      before: 'v1',
      occurredAt: '2026-01-01T00:00:45Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-2',
    });

    const preview = await rewindToMessage(fixture.db, {
      messageId: 'msg-3',
      threadId: THREAD_ID,
    });
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
    // ONE folded entry for the file both runs touched — the existing view, not
    // a second computation.
    expect(preview.view?.files.map((file) => file.path)).toEqual(['/a.txt']);
    expect(preview.view?.totalAdditions).toBeNull();
  });

  it('rejects an unknown message instead of previewing an empty rewind', async () => {
    await seedTwoTurnThread();
    const preview = await rewindToMessage(fixture.db, {
      messageId: 'msg-nope',
      threadId: THREAD_ID,
    });
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.reason).toBe('message-not-found');
    }
  });

  it('reports a thread with no runs after the message as an honest empty range', async () => {
    await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:00Z', id: 'solo-1' });
    const preview = await rewindToMessage(fixture.db, {
      messageId: 'solo-1',
      threadId: THREAD_ID,
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.range).toEqual({ kind: 'none', reason: 'no-runs-after-message' });
      expect(preview.changeset).toBeNull();
      expect(preview.view).toBeNull();
    }
  });
});

describe('finalizeThreadRewinds', () => {
  it('hard-deletes through the store seam and clears the sidecar rows', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      probe
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
      probe
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
      probe
    );
    const deleted: string[][] = [];
    const deps = {
      deleteMessages: async (ids: readonly string[]): Promise<void> => {
        deleted.push([...ids]);
        await deleteMessagesFrom(ids);
      },
    };

    const first = await finalizeThreadRewinds(fixture.db, THREAD_ID, deps);
    const second = await finalizeThreadRewinds(fixture.db, THREAD_ID, deps);

    expect(first.finalized).toBe(true);
    expect(second).toEqual({ deletedMessageIds: [], finalized: false, rewindIds: [] });
    expect(deleted).toEqual([['msg-5', 'msg-6']]);
  });

  it('is double-FIRE safe: two concurrent finalizations delete exactly once', async () => {
    await seedTwoTurnThread();
    await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-only', threadId: THREAD_ID },
      probe
    );
    const deleted: string[][] = [];
    const deps = {
      deleteMessages: async (ids: readonly string[]): Promise<void> => {
        deleted.push([...ids]);
        await deleteMessagesFrom(ids);
      },
    };

    const [first, second] = await Promise.all([
      finalizeThreadRewinds(fixture.db, THREAD_ID, deps),
      finalizeThreadRewinds(fixture.db, THREAD_ID, deps),
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
      probe
    );
    if (!result.ok) {
      throw new Error('fixture rewind was refused');
    }
    return result.rewindId;
  }

  it('refuses a redo of an already-finalized batch with a typed rewind-not-found', async () => {
    const rewindId = await applyConversationOnlyRewind();
    await finalizeThreadRewinds(fixture.db, THREAD_ID, { deleteMessages: deleteMessagesFrom });

    const redone = await redoRewind(fixture.db, { rewindId }, probe);

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
      redoRewind(fixture.db, { rewindId }, probe),
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

describe('applyRewind — created files', () => {
  it('deletes a file the reverted run created, and redo puts it back', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'brand new',
      before: null,
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/new.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(result.ok).toBe(true);
    expect(await readDiskFile(root(), '/new.txt')).toBeNull();
    await expect(fsPromises.stat(absolutePathFor(root(), '/new.txt'))).rejects.toThrow();

    if (!result.ok) {
      return;
    }
    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/new.txt')).toBe('brand new');
  });

  /**
   * REGRESSION — 2026-08-05 smoke round 2, defect 1. A turn that scaffolded a
   * modular app left its whole `app/` directory tree standing after the rewind,
   * because the journal records FILE ops only. The apply path now prunes the
   * emptied ancestors; REDO must not (it restores the pre-rewind state, in
   * which those directories existed) — recreating them is `writeFile`'s job.
   */
  it('prunes the directory tree a scaffolding turn created, and redo rebuilds it', async () => {
    await seedTwoTurnThread();
    for (const [index, filePath] of [
      '/app/src/main.tsx',
      '/app/src/components/Button.tsx',
      '/app/package.json',
    ].entries()) {
      await seedWrite(fixture, {
        after: `scaffold ${index}`,
        before: null,
        occurredAt: `2026-01-01T00:00:2${5 + index}Z`,
        path: filePath,
        rootId: ROOT_ID,
        runId: 'run-1',
      });
    }

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(result.ok).toBe(true);
    await expect(fsPromises.stat(absolutePathFor(root(), '/app'))).rejects.toThrow();
    // The root is the boundary, never a prune candidate.
    expect((await fsPromises.stat(root())).isDirectory()).toBe(true);

    if (!result.ok) {
      return;
    }
    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/app/src/components/Button.tsx')).toBe('scaffold 1');
    expect((await fsPromises.stat(absolutePathFor(root(), '/app/src'))).isDirectory()).toBe(true);
  });
});

/**
 * REGRESSION — the destructive defect from the 2026-08-05 live smoke, recovered
 * verbatim from the production journal (thread-f73c888a): rewinding one turn
 * DELETED a file an EARLIER turn had created, instead of restoring it.
 *
 * A user turn is not one run. Every tool-approval / askUser resume mints a new
 * run row through the same `prepareRequestData` -> `createThreadRun` seam, and
 * the turn's assistant message row is persisted at the START of the turn (it is
 * upserted in place as the turn streams on). So a turn's LATER runs — the ones
 * that usually do the file work — start well AFTER that turn's own assistant
 * message. Anchoring the range on the message PRECEDING the target therefore
 * swept the previous turn's tail into the revert, and reverting its `created`
 * capture is an `unlink`.
 *
 * Production numbers this mirrors: target message at 04:58:19.849; the swept
 * run started at 04:56:58.397 — 81 SECONDS BEFORE the message the user rewound
 * to — and had already completed at 04:57:51.341.
 */
describe('applyRewind — the range never reaches back past the target message', () => {
  async function seedResumedTurnThread(): Promise<void> {
    // Turn A: prompt, first run, assistant row, then a RESUME run that creates
    // the file. Run rows are minted on send, ~milliseconds before Mastra
    // persists the user message — the ordering the old anchor was built around.
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
    await seedWrite(fixture, {
      after: 'the page turn A built',
      before: null,
      occurredAt: '2026-03-01T00:01:40Z',
      path: '/page.html',
      rootId: ROOT_ID,
      runId: 'run-a2',
    });
    await seedWrite(fixture, {
      after: 'the page turn B edited',
      before: 'the page turn A built',
      occurredAt: '2026-03-01T00:03:20Z',
      path: '/page.html',
      rootId: ROOT_ID,
      runId: 'run-b1',
    });

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-c', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Turn A's create is NOT in range: exactly one file operation is reverted.
    expect(result.fileOutcomes.map((outcome) => outcome.code)).toEqual(['reverted']);
    expect(result.range.kind === 'runs' ? result.range.runIds : []).toEqual(['run-b1']);
    // The file the user asked to keep still exists, with turn A's content.
    expect(await readDiskFile(root(), '/page.html')).toBe('the page turn A built');
    // Only turn B's messages are hidden — the conversation side was never wrong.
    expect(result.tombstonedMessageIds).toEqual(['msg-c', 'msg-d']);
  });

  it('previews the same narrowed range it would apply', async () => {
    await seedResumedTurnThread();
    await seedWrite(fixture, {
      after: 'the page turn A built',
      before: null,
      occurredAt: '2026-03-01T00:01:40Z',
      path: '/page.html',
      rootId: ROOT_ID,
      runId: 'run-a2',
    });
    await seedWrite(fixture, {
      after: 'the page turn B edited',
      before: 'the page turn A built',
      occurredAt: '2026-03-01T00:03:20Z',
      path: '/page.html',
      rootId: ROOT_ID,
      runId: 'run-b1',
    });

    const preview = await rewindToMessage(fixture.db, {
      messageId: 'msg-c',
      threadId: THREAD_ID,
    });

    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.range.kind === 'runs' ? preview.range.runIds : []).toEqual(['run-b1']);
  });
});
