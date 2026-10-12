/**
 * The Conversation Rewind IPC surface, end to end (BST-1115 W5 T4; snapshot
 * engine BST-1164 W7 T3).
 *
 * REAL PGlite + REAL filesystem + REAL shadow git + the REAL rewind service —
 * only the reindex side effects are a probe. What this suite exists to prove
 * is the boundary itself: that a renderer payload is narrowed before it
 * reaches a destructive operation, that the acknowledgment gate (now bound to
 * the preview fingerprint) survives the trip through IPC, that the snapshot
 * seams are threaded through `createSnapshotRepository`/
 * `resolveSnapshotService` rather than constructed twice, and that a
 * run-target resolves to its triggering message in the main process rather
 * than being guessed by the renderer.
 *
 * MULTI-ROOT BAR: the range spans TWO git repositories plus one root outside
 * any repository AND a shell-created file (direct fs write), and the per-root
 * roll-up must name all three roots through the IPC result — never a silently
 * skipped root.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => {
    throw new Error('getDatabase must not be called by the rewind IPC tests');
  }),
}));

import type {
  AssistantRewindApplied,
  AssistantRewindResult,
} from '@brainstrike/assistant-contract';
import type { GitResult } from '@brainstrike/types';
import type { MainQueryHandle } from '../../assistant-server/main-query-handle';
import { resolveRewindMessageForRun } from '../../assistant-server/rewind-repository';
import {
  applyRewind,
  finalizeThreadRewinds,
  redoRewind,
  rewindToMessage,
} from '../../assistant-server/rewind-service';
import { type ChangesIpcHandlers, createChangesIpcHandlers } from '../../changes-ipc-handlers';
import {
  cleanupTempDirs,
  createReindexProbe,
  createRewindFixture,
  createSnapshotHarness,
  insertMessage,
  insertRun,
  makeGitRepo,
  makeTempDir,
  type ReindexProbe,
  type RewindFixture,
  readDiskFile,
  type SnapshotHarness,
  seedTurnStartSnapshots,
  THREAD_ID,
  writeDiskFile,
} from './rewind-service-test-support';

const REPO_A = 'root-repo-a';
const REPO_B = 'root-repo-b';
/** Mounted folder that is NOT a git repository — the "out-of-repo file". */
const PLAIN_C = 'root-plain-c';

let fixture: RewindFixture;
let probe: ReindexProbe;
let harness: SnapshotHarness;
let handlers: ChangesIpcHandlers;
/** Message ids each finalization asked the store seam to hard-delete. */
let finalizedDeletes: string[][];

function rootPath(rootId: string): string {
  const resolved = fixture.rootPaths[rootId];
  if (!resolved) {
    throw new Error(`fixture root "${rootId}" missing`);
  }
  return resolved;
}

/** Unwrap a transport-level success, failing loudly on a transport failure. */
function value<T>(result: GitResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected a transport success, got: ${result.error}`);
  }
  return result.value;
}

function applied(result: AssistantRewindResult): AssistantRewindApplied {
  if (!result.ok) {
    throw new Error(`expected an applied rewind, got refusal: ${result.message}`);
  }
  return result;
}

/**
 * msg-1 (assistant) → run-1 → msg-2 (user) → run-2 → msg-3 (user).
 *
 * Run rows start BEFORE the message they were triggered by, which is the race
 * `resolveRewindMessageForRun` and `resolveRewindRunRange` both anchor around.
 */
async function seedThread(): Promise<void> {
  await insertMessage(fixture.db, {
    createdAt: '2026-02-01T00:00:00Z',
    id: 'msg-1',
    role: 'assistant',
  });
  await insertRun(fixture.db, { id: 'run-1', startedAt: '2026-02-01T00:00:10Z' });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:11Z', id: 'msg-2' });
  await insertRun(fixture.db, { id: 'run-2', startedAt: '2026-02-01T00:00:20Z' });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:21Z', id: 'msg-3' });
}

/**
 * v0 state in all three roots → turn-start snapshots for run-1 → the turn's
 * edits, INCLUDING a shell-created lockfile (a direct fs write, no tool).
 */
async function seedThreeRootHistory(): Promise<void> {
  await writeDiskFile(rootPath(REPO_A), '/src/index.ts', 'a-v0');
  await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'b-v0');
  await writeDiskFile(rootPath(PLAIN_C), '/notes/scratch.md', 'c-v0');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
  await writeDiskFile(rootPath(REPO_A), '/src/index.ts', 'a-v1');
  await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'b-v1');
  await writeDiskFile(rootPath(PLAIN_C), '/notes/scratch.md', 'c-v1');
  await writeDiskFile(rootPath(PLAIN_C), '/notes/generated.lock', 'shell wrote this');
}

/** Preview through the IPC surface — the fingerprint a files apply binds. */
async function previewThroughIpc(messageId: string): Promise<void> {
  const preview = value(await handlers.rewindPreview({ messageId, threadId: THREAD_ID }));
  if (!preview.ok) {
    throw new Error(`fixture preview refused: ${preview.message}`);
  }
}

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture(
    {
      [PLAIN_C]: await makeTempDir('bs-rewind-ipc-plain-'),
      [REPO_A]: await makeGitRepo('bs-rewind-ipc-repo-a-'),
      [REPO_B]: await makeGitRepo('bs-rewind-ipc-repo-b-'),
    },
    `rewind-ipc-${crypto.randomUUID()}`
  );
  harness = await createSnapshotHarness(fixture.db);
  finalizedDeletes = [];
  handlers = createChangesIpcHandlers({
    // The T1 injection seams, exactly as main.ts threads them: the handlers
    // must compose the snapshot deps from THESE, never construct their own.
    createSnapshotRepository: () => harness.repository,
    resolveDatabase: async () => fixture.db as unknown as MainQueryHandle,
    resolveSnapshotService: () => harness.service,
    rewind: {
      applyRewind,
      // Stands in for `createRewindFinalizationDeps`, which builds a
      // `PgliteMemoryStore` over the main-process database. Deleting the rows
      // for real keeps the post-finalization assertions honest.
      createFinalizationDeps: async () => ({
        deleteMessages: async (messageIds: readonly string[]) => {
          finalizedDeletes.push([...messageIds]);
          await fixture.db.query('DELETE FROM mastra_messages WHERE id = ANY($1::text[])', [
            [...messageIds],
          ]);
        },
      }),
      // The real deps resolve an embedding set and fire the app's reindex side
      // effects; the probe keeps this suite about the IPC boundary.
      createRevertDeps: async () => ({ reindex: probe.reindex }),
      finalizeThreadRewinds,
      redoRewind,
      resolveMessageForRun: resolveRewindMessageForRun,
      rewindToMessage,
    },
  });
  await seedThread();
});

afterEach(async () => {
  await cleanupTempDirs();
});

describe('changes:rewindPreview payload narrowing', () => {
  it.each([
    [undefined, 'requires an object payload'],
    [{ messageId: 'msg-2' }, 'requires a non-empty threadId'],
    [{ threadId: THREAD_ID }, 'exactly one of messageId or runId'],
    [{ messageId: 'msg-2', runId: 'run-1', threadId: THREAD_ID }, 'exactly one of'],
    [{ messageId: '', threadId: THREAD_ID }, 'messageId must be a non-empty string'],
    [{ nope: 1, threadId: THREAD_ID }, 'does not accept: nope'],
  ])('rejects %j as a typed failure, never a throw', async (payload, expected) => {
    const result = await handlers.rewindPreview(payload);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(expected);
  });

  it('resolves a MESSAGE target to the range that message anchors', async () => {
    await seedThreeRootHistory();

    const preview = value(
      await handlers.rewindPreview({ messageId: 'msg-2', threadId: THREAD_ID })
    );

    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    expect(preview.messageId).toBe('msg-2');
    expect(preview.range).toEqual({
      fromRunId: 'run-1',
      kind: 'runs',
      runIds: ['run-1', 'run-2'],
    });
    // The preview view is the snapshot engine's own resolution — three roots,
    // four files (the shell-created lockfile INCLUDED), none dropped for
    // lacking a git repository.
    expect(preview.view?.files.map((file) => file.rootId).sort()).toEqual(
      [PLAIN_C, PLAIN_C, REPO_A, REPO_B].sort()
    );
    expect(preview.view?.files.find((file) => file.path === 'notes/generated.lock')?.status).toBe(
      'added'
    );
    expect(preview.filesScope).toEqual({ available: true });
    expect(preview.tombstoneMessageIds).toEqual(['msg-2', 'msg-3']);
  });

  it('resolves a RUN target to that run’s triggering message, in main', async () => {
    await seedThreeRootHistory();

    const preview = value(await handlers.rewindPreview({ runId: 'run-1', threadId: THREAD_ID }));

    expect(preview.ok).toBe(true);
    // run-1 started BEFORE msg-2 was persisted; the earliest message after the
    // run's start is the one that triggered it.
    expect(preview.ok === true && preview.messageId).toBe('msg-2');
    expect(preview.ok === true && preview.range).toEqual({
      fromRunId: 'run-1',
      kind: 'runs',
      runIds: ['run-1', 'run-2'],
    });
  });

  it('refuses an unresolvable run VISIBLY instead of inventing a message id', async () => {
    const preview = value(
      await handlers.rewindPreview({ runId: 'run-does-not-exist', threadId: THREAD_ID })
    );

    expect(preview.ok).toBe(false);
    expect(preview.ok === false && preview.reason).toBe('message-not-found');
    expect(preview.ok === false && preview.message).toContain('run-does-not-exist');
  });
});

describe('changes:applyRewind payload narrowing', () => {
  it('rejects a payload with no mode — there is no default that touches disk', async () => {
    const result = await handlers.applyRewind({ messageId: 'msg-2', threadId: THREAD_ID });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('requires an explicit mode');
  });

  it('rejects an unknown mode by name', async () => {
    const result = await handlers.applyRewind({
      messageId: 'msg-2',
      mode: 'files-only',
      threadId: THREAD_ID,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"files-only"');
  });

  it('rejects a non-boolean acknowledgeConflicts', async () => {
    const result = await handlers.applyRewind({
      acknowledgeConflicts: 'yes',
      messageId: 'msg-2',
      mode: 'conversation-and-files',
      threadId: THREAD_ID,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('must be a boolean');
  });
});

describe('changes:applyRewind across three roots', () => {
  it('conversation-only writes tombstones and touches NO file in ANY root', async () => {
    await seedThreeRootHistory();

    const outcome = applied(
      value(
        await handlers.applyRewind({
          messageId: 'msg-2',
          mode: 'conversation-only',
          threadId: THREAD_ID,
        })
      )
    );

    expect(outcome.mode).toBe('conversation-only');
    expect(outcome.revertId).toBeNull();
    expect(outcome.tombstonedMessageIds).toEqual(['msg-2', 'msg-3']);
    expect(outcome.fileOutcomes).toEqual([]);
    expect(outcome.rootOutcomes).toEqual([]);
    // Every root still holds the turn's version — shell file included.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v1');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/generated.lock')).toBe('shell wrote this');
  });

  it('conversation-and-files restores all three roots, removes the shell-created file, and rolls up per root', async () => {
    await seedThreeRootHistory();
    await previewThroughIpc('msg-2');

    const outcome = applied(
      value(
        await handlers.applyRewind({
          messageId: 'msg-2',
          mode: 'conversation-and-files',
          threadId: THREAD_ID,
        })
      )
    );

    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v0');
    // The shell-created file is GONE — the fixture class the journal engine
    // structurally could not restore. Strengthened, not weakened, by the swap.
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/generated.lock')).toBeNull();

    // EVERY root appears, each with its own honest counts — the MULTI-ROOT BAR
    // forbids communicating a root's outcome by absence.
    const byRoot = new Map(outcome.rootOutcomes.map((root) => [root.rootId, root]));
    expect([...byRoot.keys()].sort()).toEqual([PLAIN_C, REPO_A, REPO_B].sort());
    expect(byRoot.get(REPO_A)).toMatchObject({ attempted: 1, conflicts: 0, reverted: 1 });
    expect(byRoot.get(REPO_B)).toMatchObject({ attempted: 1, conflicts: 0, reverted: 1 });
    expect(byRoot.get(PLAIN_C)).toMatchObject({ attempted: 2, conflicts: 0, reverted: 2 });
  });

  it('refuses a files-mode apply with no recorded preview, through IPC', async () => {
    await seedThreeRootHistory();

    const refused = value(
      await handlers.applyRewind({
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      })
    );

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('preview-required');
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v1');
  });

  it('BLOCKS the whole apply when ONE root drifts after the preview, until acknowledged', async () => {
    await seedThreeRootHistory();
    await previewThroughIpc('msg-2');
    // The user edits repo B's file AFTER the preview was generated.
    await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'b-user-edit');

    const refused = value(
      await handlers.applyRewind({
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      })
    );

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('conflicts-unacknowledged');
    expect(refused.ok === false && refused.conflicts.map((conflict) => conflict.rootId)).toEqual([
      REPO_B,
    ]);
    // NOTHING was applied — not the clean roots, not the tombstones.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
    const tombstones = await fixture.db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_message_tombstones'
    );
    expect(tombstones.rows[0]?.count).toBe(0);

    const acknowledged = applied(
      value(
        await handlers.applyRewind({
          acknowledgeConflicts: true,
          messageId: 'msg-2',
          mode: 'conversation-and-files',
          threadId: THREAD_ID,
        })
      )
    );

    expect(acknowledged.tombstonedMessageIds).toEqual(['msg-2', 'msg-3']);
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
  });
});

describe('changes:redoRewind', () => {
  it('rejects a payload with no rewindId', async () => {
    const result = await handlers.redoRewind({});

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('requires a non-empty rewindId');
  });

  it('undoes a files-mode rewind across every root, shell file included', async () => {
    await seedThreeRootHistory();
    await previewThroughIpc('msg-2');
    const outcome = applied(
      value(
        await handlers.applyRewind({
          messageId: 'msg-2',
          mode: 'conversation-and-files',
          threadId: THREAD_ID,
        })
      )
    );
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/generated.lock')).toBeNull();

    const redone = value(await handlers.redoRewind({ rewindId: outcome.rewindId }));

    expect(redone.ok).toBe(true);
    expect(redone.ok === true && [...redone.restoredMessageIds].sort()).toEqual(['msg-2', 'msg-3']);
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v1');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/generated.lock')).toBe('shell wrote this');
  });

  it('refuses an unknown batch VISIBLY', async () => {
    const redone = value(await handlers.redoRewind({ rewindId: 'nope' }));

    expect(redone.ok).toBe(false);
    expect(redone.ok === false && redone.reason).toBe('rewind-not-found');
  });
});

/**
 * W5 T4b — `changes:finalizeRewinds`, the channel the renderer fires when a
 * USER-authored message starts a new run. This is what ends the redo window;
 * before it existed, `finalizeThreadRewinds` was referenced only from tests and
 * tombstoned messages were never hard-deleted.
 */
describe('changes:finalizeRewinds', () => {
  async function tombstoneCount(): Promise<number> {
    const result = await fixture.db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_message_tombstones'
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  it.each([
    [undefined, 'requires an object payload'],
    [{}, 'requires a non-empty threadId'],
    [{ threadId: '' }, 'requires a non-empty threadId'],
    [{ resourceId: 'r', threadId: THREAD_ID }, 'does not accept: resourceId'],
  ])('rejects a malformed payload (%j)', async (payload, expected) => {
    const result = await handlers.finalizeRewinds(payload);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(expected);
  });

  it('hard-deletes the thread`s tombstoned messages through the store seam', async () => {
    await seedThreeRootHistory();
    await previewThroughIpc('msg-2');
    value(
      await handlers.applyRewind({
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      })
    );
    expect(await tombstoneCount()).toBe(2);

    const finalization = value(await handlers.finalizeRewinds({ threadId: THREAD_ID }));

    expect(finalization.finalized).toBe(true);
    expect(finalizedDeletes).toEqual([['msg-2', 'msg-3']]);
    expect([...finalization.deletedMessageIds].sort()).toEqual(['msg-2', 'msg-3']);
    expect(finalization.rewindIds).toHaveLength(1);
    expect(await tombstoneCount()).toBe(0);
  });

  it('closes the redo window: a redo after finalization is a typed refusal', async () => {
    const outcome = applied(
      value(
        await handlers.applyRewind({
          messageId: 'msg-2',
          mode: 'conversation-only',
          threadId: THREAD_ID,
        })
      )
    );

    value(await handlers.finalizeRewinds({ threadId: THREAD_ID }));
    const redone = value(await handlers.redoRewind({ rewindId: outcome.rewindId }));

    expect(redone.ok).toBe(false);
    expect(redone.ok === false && redone.reason).toBe('rewind-not-found');
  });

  it('answers finalized:false for a thread with no outstanding rewind, without deleting', async () => {
    const finalization = value(await handlers.finalizeRewinds({ threadId: THREAD_ID }));

    expect(finalization).toEqual({ deletedMessageIds: [], finalized: false, rewindIds: [] });
    expect(finalizedDeletes).toEqual([]);
  });

  it('reports a store-seam failure as a VISIBLE transport failure, leaving the tombstones', async () => {
    const failing = createChangesIpcHandlers({
      createSnapshotRepository: () => harness.repository,
      resolveDatabase: async () => fixture.db as unknown as MainQueryHandle,
      resolveSnapshotService: () => harness.service,
      rewind: {
        applyRewind,
        createFinalizationDeps: async () => ({
          deleteMessages: async () => {
            throw new Error('memory store unavailable');
          },
        }),
        createRevertDeps: async () => ({ reindex: probe.reindex }),
        finalizeThreadRewinds,
        redoRewind,
        resolveMessageForRun: resolveRewindMessageForRun,
        rewindToMessage,
      },
    });
    value(
      await failing.applyRewind({
        messageId: 'msg-2',
        mode: 'conversation-only',
        threadId: THREAD_ID,
      })
    );

    const result = await failing.finalizeRewinds({ threadId: THREAD_ID });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('memory store unavailable');
    // The messages could not be removed, so they must stay HIDDEN — dropping
    // the sidecar rows anyway would resurrect a rewound conversation.
    expect(await tombstoneCount()).toBe(2);
  });

  it('fails VISIBLY when the snapshot service is not wired, instead of degrading', async () => {
    const unwired = createChangesIpcHandlers({
      resolveDatabase: async () => fixture.db as unknown as MainQueryHandle,
      rewind: {
        applyRewind,
        createFinalizationDeps: async () => ({ deleteMessages: async () => undefined }),
        createRevertDeps: async () => ({ reindex: probe.reindex }),
        finalizeThreadRewinds,
        redoRewind,
        resolveMessageForRun: resolveRewindMessageForRun,
        rewindToMessage,
      },
    });

    const result = await unwired.rewindPreview({ messageId: 'msg-2', threadId: THREAD_ID });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('snapshot service is not running');
  });
});
