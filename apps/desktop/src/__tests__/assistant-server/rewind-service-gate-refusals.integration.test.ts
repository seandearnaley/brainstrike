/**
 * Conversation Rewind — PR-review round refusals (BST-1115, W5).
 *
 * Split out of `rewind-service.integration.test.ts` (which hit the
 * per-file line cap) rather than folded in: these four cover REVIEW-FOUND
 * gaps in the destructive-seam refusals, kept together as their own unit.
 *
 * MUTATION-VERIFIED: each `it` below was confirmed to FAIL against the
 * pre-fix implementation (the guard/ordering removed or reverted to the
 * millisecond-truncated JS sort) before being accepted.
 *
 * REAL PGlite + REAL filesystem; only the reindex seam is a probe.
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

import { sha256Hex } from '../../assistant-server/edit-checkpoint-journal';
import { applyRewind, redoRewind } from '../../assistant-server/rewind-service';
import {
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

/** Same two-turn, two-run shape as `rewind-service.integration.test.ts` —
 * see that file's `seedTwoTurnThread` for why the range anchors on the
 * PRECEDING message. */
async function seedTwoTurnThread(): Promise<void> {
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:00Z', id: 'msg-1' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:10Z',
    id: 'msg-2',
    role: 'assistant',
  });
  await insertRun(fixture.db, { id: 'run-1', startedAt: '2026-01-01T00:00:20Z' });
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:21Z', id: 'msg-3' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:30Z',
    id: 'msg-4',
    role: 'assistant',
  });
  await insertRun(fixture.db, { id: 'run-2', startedAt: '2026-01-01T00:00:40Z' });
  await insertMessage(fixture.db, { createdAt: '2026-01-01T00:00:41Z', id: 'msg-5' });
  await insertMessage(fixture.db, {
    createdAt: '2026-01-01T00:00:50Z',
    id: 'msg-6',
    role: 'assistant',
  });
}

async function tombstoneRows(): Promise<{ messageId: string; rewindId: string }[]> {
  const result = await fixture.db.query<{ messageId: string; rewindId: string }>(
    `SELECT message_id AS "messageId", rewind_id AS "rewindId"
     FROM brainstrike_assistant_message_tombstones
     ORDER BY message_id ASC`
  );
  return result.rows;
}

/** Direct-SQL insert bypassing `recordEditCheckpoint`'s `occurredAt: Date`
 * interface (millisecond precision), so a test can plant two checkpoints for
 * the same file inside the SAME millisecond but genuinely ordered at
 * microsecond precision — the exact case `occurred_at`-in-SQL ordering exists
 * to get right. */
async function insertCheckpointRowAt(args: {
  after: string;
  before: string;
  id: string;
  occurredAt: string;
  path: string;
  runId: string;
}): Promise<void> {
  await fixture.db.query(
    `INSERT INTO brainstrike_assistant_edit_checkpoints (
       id, run_id, resource_id, thread_id, tool_call_id, tool_name, op, root_id,
       path, from_path, before_existed, before_hash, before_content, before_size,
       after_hash, after_existed, capture_status, occurred_at, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, NULL, 'brainstrike.writeWorkspaceFile', 'write', $5,
       $6, NULL, true, $7, $8, $9, $10, true, 'ok', $11::timestamptz, NOW(), NOW()
     )`,
    [
      args.id,
      args.runId,
      RESOURCE_ID,
      THREAD_ID,
      ROOT_ID,
      args.path,
      sha256Hex(args.before),
      args.before,
      Buffer.byteLength(args.before, 'utf8'),
      sha256Hex(args.after),
      args.occurredAt,
    ]
  );
}

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture({ [ROOT_ID]: await makeTempDir() }, 'rewind-service-gates');
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — microsecond-precision ordering', () => {
  it('reverts newest-first even when two edits tie at millisecond precision', async () => {
    await seedTwoTurnThread();
    // v0 -[older edit]-> v1 -[newer edit]-> v2 (current disk). Both edits land
    // in the SAME millisecond (`.000100Z` / `.000200Z`, both truncate to
    // `.000Z`), so `AssistantEditCheckpointRecord.occurredAt` (millisecond
    // ISO strings) cannot tell them apart — only `occurred_at`'s stored
    // microseconds can. `id` is chosen to be the OPPOSITE of correct: the
    // older row's id sorts LEXICOGRAPHICALLY LARGER than the newer row's, so
    // a broken id-tiebreak would revert the OLDER edit first.
    await writeDiskFile(root(), '/a.txt', 'v2');
    await insertCheckpointRowAt({
      after: 'v1',
      before: 'v0',
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      occurredAt: '2026-01-01T00:00:25.000100Z',
      path: '/a.txt',
      runId: 'run-1',
    });
    await insertCheckpointRowAt({
      after: 'v2',
      before: 'v1',
      id: '00000000-0000-4000-8000-000000000001',
      occurredAt: '2026-01-01T00:00:25.000200Z',
      path: '/a.txt',
      runId: 'run-1',
    });

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    // Reverted in the WRONG (older-first) order, the older entry's conflict
    // check reads disk as v2 (still un-reverted) instead of its own v1, so it
    // would report a spurious `disk-changed` conflict instead of applying
    // clean. The correct newest-first order finds none.
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.fileOutcomes.map((outcome) => outcome.code)).toEqual(['reverted', 'reverted']);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
  });
});

describe('applyRewind — already-tombstoned refusal', () => {
  it('refuses a coupled apply whose target messages are all hidden by an earlier open batch', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:45Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-2',
    });

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

    // Same target, now coupled: every message it would hide is ALREADY hidden
    // by `first`, so `insertTombstoneBatch` inserts nothing for this batch.
    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-5', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('already-tombstoned');
    }
    // Nothing was touched: no file write, no reindex call, and the original
    // batch still exclusively owns the tombstone rows.
    expect(probe.calls).toEqual([]);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    const rows = await tombstoneRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.rewindId).toBe(first.rewindId);
    }
  });
});

describe('applyRewind — range-already-reverted refusal', () => {
  it('refuses rather than silently no-opping when redo left the range fully stamped', async () => {
    await seedTwoTurnThread();
    await seedWrite(fixture, {
      after: 'v1',
      before: 'v0',
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });

    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');

    const redone = await redoRewind(fixture.db, { rewindId: applied.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    // Redo does not clear `reverted_at` on the ORIGINAL journal entry (tracked
    // minor (f)): the range still resolves the same journal row, but the
    // pre-flight scan excludes it as already-reverted.
    const second = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    // The forbidden outcome is `ok: true` with empty `fileOutcomes`/
    // `rootOutcomes` — a "successful" rewind that silently touched no file.
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('range-already-reverted');
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v1');
    // Refused before the gate, so no new tombstone batch was opened either.
    expect(await tombstoneRows()).toEqual([]);
  });
});

describe('redoRewind — partial-failure honesty', () => {
  it('keeps the tombstone batch and the messages hidden when a file conflicts mid-redo', async () => {
    await seedTwoTurnThread();
    const seeds = {
      '/a.txt': { after: 'v1', before: 'v0' },
      '/b.txt': { after: 'b1', before: 'b0' },
    } as const;
    await seedWrite(fixture, {
      after: seeds['/a.txt'].after,
      before: seeds['/a.txt'].before,
      occurredAt: '2026-01-01T00:00:25Z',
      path: '/a.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });
    await seedWrite(fixture, {
      after: seeds['/b.txt'].after,
      before: seeds['/b.txt'].before,
      occurredAt: '2026-01-01T00:00:26Z',
      path: '/b.txt',
      rootId: ROOT_ID,
      runId: 'run-1',
    });

    const applied = await applyRewind(
      fixture.db,
      { messageId: 'msg-3', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    expect(await readDiskFile(root(), '/a.txt')).toBe('v0');
    expect(await readDiskFile(root(), '/b.txt')).toBe('b0');

    // A TOCTOU probe, ORDER-AGNOSTIC on purpose: redo's own capture-row order
    // is real wall-clock timing (`recordEditCheckpoint`'s default
    // `occurredAt`), not something this test should assume a direction for.
    // Whichever file redo restores FIRST, an external process overwrites the
    // OTHER one before `executePlan` reaches it — after redo's own pre-scan
    // already passed it clean, so this is invisible to the gate and only
    // catchable at the per-file write.
    let restoredFirst: '/a.txt' | '/b.txt' | null = null;
    const toctouProbe: typeof probe = {
      ...probe,
      reindex: async (action) => {
        await probe.reindex(action);
        if (action.kind === 'restore' && restoredFirst === null) {
          restoredFirst = action.workspacePath as '/a.txt' | '/b.txt';
          const other = restoredFirst === '/a.txt' ? '/b.txt' : '/a.txt';
          await writeDiskFile(root(), other, 'external-edit');
        }
      },
    };

    const redone = await redoRewind(fixture.db, { rewindId: applied.rewindId }, toctouProbe);
    expect(restoredFirst).not.toBeNull();
    const first = restoredFirst as unknown as '/a.txt' | '/b.txt';
    const second = first === '/a.txt' ? '/b.txt' : '/a.txt';

    expect(redone.ok).toBe(false);
    if (!redone.ok) {
      expect(redone.reason).toBe('redo-incomplete');
      expect(redone.message).toContain(second);
    }
    // The successful half actually landed...
    expect(await readDiskFile(root(), first)).toBe(seeds[first].after);
    // ...but the failed half was left exactly as the TOCTOU left it, and the
    // messages STAY HIDDEN rather than reappearing over a partial restore.
    expect(await readDiskFile(root(), second)).toBe('external-edit');
    expect(await tombstoneRows()).toHaveLength(4);

    // Retry, without the external interference: the already-succeeded entry
    // is an idempotent no-op and the batch completes.
    await writeDiskFile(root(), second, seeds[second].before);
    const retried = await redoRewind(fixture.db, { rewindId: applied.rewindId }, probe);
    expect(retried.ok).toBe(true);
    expect(await readDiskFile(root(), second)).toBe(seeds[second].after);
    expect(await tombstoneRows()).toEqual([]);
  });
});
