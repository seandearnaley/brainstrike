/**
 * MULTI-ROOT BAR for Conversation Rewind (BST-1115 W5 T3; snapshot engine
 * BST-1164 W7 T3) — the user's headline requirement.
 *
 * A single turn spans edits in TWO git repositories PLUS one root that is not
 * a repository at all, INCLUDING a file created by a direct `fs` write (the
 * shell-side-effect fixture class the journal engine structurally could not
 * pass — plan §Global 7). Restore must put all of it back, report PER-ROOT
 * outcomes, and never partially-silently-skip a root — including a root that
 * has since been disconnected, which must surface as a named conflict and an
 * explicit `rootPath: null` outcome rather than a quiet omission.
 *
 * MUTATION-VERIFIED (each mutation applied, named test observed to fail,
 * mutation reverted — see the task report):
 * - Dropping the `disconnectedRootConflicts` entries from `applyRewindLocked`'s
 *   gate list fails "a disconnected root is reported by name" (the apply
 *   sails through with the root silently skipped).
 * - Dropping the disconnected roots from `buildRootOutcomes` fails the same
 *   test's roll-up assertion (the root vanishes from `rootOutcomes`).
 * - Making `executeSnapshotRestore` iterate roots with `Promise.all` fails
 *   "restores two repositories and one plain root" via the reindex probe's
 *   overlap detector.
 * - Skipping the `delete-file` plan actions in `applyRestorePlan` (treating
 *   them as restored) fails "the shell-created lockfile is REMOVED".
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
  disconnectRoot,
  insertMessage,
  insertRun,
  makeGitRepo,
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

const REPO_A = 'root-repo-a';
const REPO_B = 'root-repo-b';
/** Mounted folder that is NOT a git repository — the "out-of-repo file". */
const PLAIN_C = 'root-plain-c';

let fixture: RewindFixture;
let probe: ReindexProbe;
let harness: SnapshotHarness;
let deps: RewindServiceDeps;

function rootPath(rootId: string): string {
  const resolved = fixture.rootPaths[rootId];
  if (!resolved) {
    throw new Error(`fixture root "${rootId}" missing`);
  }
  return resolved;
}

async function seedThread(): Promise<void> {
  await insertMessage(fixture.db, {
    createdAt: '2026-02-01T00:00:00Z',
    id: 'msg-1',
    role: 'assistant',
  });
  await insertRun(fixture.db, {
    completedAt: '2026-02-01T00:00:15Z',
    id: 'run-1',
    startedAt: '2026-02-01T00:00:10Z',
  });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:11Z', id: 'msg-2' });
  await insertRun(fixture.db, {
    completedAt: '2026-02-01T00:00:25Z',
    id: 'run-2',
    startedAt: '2026-02-01T00:00:20Z',
  });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:21Z', id: 'msg-3' });
}

/**
 * The same RELATIVE path in both repos, a third file outside any repo, and a
 * SHELL-CREATED lockfile (direct fs write, no tool anywhere) — all inside one
 * range, with a second run editing repo A again so the restore spans runs.
 */
async function seedThreeRootHistory(): Promise<void> {
  await writeDiskFile(rootPath(REPO_A), '/src/index.ts', 'a-v0');
  await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'b-v0');
  await writeDiskFile(rootPath(PLAIN_C), '/notes/scratch.md', 'c-v0');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-1' });
  // Turn 1's edits — plus the lockfile a shell command (npm install) created.
  await writeDiskFile(rootPath(REPO_A), '/src/index.ts', 'a-v1');
  await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'b-v1');
  await writeDiskFile(rootPath(PLAIN_C), '/notes/scratch.md', 'c-v1');
  await writeDiskFile(rootPath(REPO_A), '/generated/package-lock.json', '{ "lock": 1 }');
  await seedTurnStartSnapshots(harness, fixture, { runId: 'run-2' });
  await writeDiskFile(rootPath(REPO_A), '/src/index.ts', 'a-v2');
}

async function previewFor(messageId: string): Promise<void> {
  const preview = await rewindToMessage(fixture.db, { messageId, threadId: THREAD_ID }, deps);
  if (!preview.ok) {
    throw new Error(`fixture preview refused: ${preview.message}`);
  }
}

beforeEach(async () => {
  probe = createReindexProbe();
  fixture = await createRewindFixture(
    {
      [PLAIN_C]: await makeTempDir('bs-rewind-plain-'),
      [REPO_A]: await makeGitRepo(),
      [REPO_B]: await makeGitRepo(),
    },
    'rewind-multiroot'
  );
  harness = await createSnapshotHarness(fixture.db);
  deps = rewindDeps(harness, probe);
  await seedThread();
  await seedThreeRootHistory();
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — multi-root range', () => {
  it('restores two repositories and one plain root, removes the shell-created file, reports every root, and redo round-trips', async () => {
    const preview = await rewindToMessage(
      fixture.db,
      { messageId: 'msg-2', threadId: THREAD_ID },
      deps
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) {
      return;
    }
    // The preview LISTS the shell-created file — the exact honesty the
    // journal engine could not offer.
    const previewPaths = preview.view?.files.map((file) => `${file.rootId}:${file.path}`) ?? [];
    expect(previewPaths.sort()).toEqual(
      [
        `${PLAIN_C}:notes/scratch.md`,
        `${REPO_A}:generated/package-lock.json`,
        `${REPO_A}:src/index.ts`,
        `${REPO_B}:src/index.ts`,
      ].sort()
    );

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Same relative path in two repos must NOT collapse into one file.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v0');
    // The shell-created lockfile is REMOVED, and its scaffolded dir with it.
    expect(await readDiskFile(rootPath(REPO_A), '/generated/package-lock.json')).toBeNull();
    // Sequential roots: the reindex probe saw no overlapping work.
    expect(probe.overlaps).toEqual([]);

    const byRoot = new Map(result.rootOutcomes.map((outcome) => [outcome.rootId, outcome]));
    expect([...byRoot.keys()].sort()).toEqual([PLAIN_C, REPO_A, REPO_B].sort());
    expect(byRoot.get(REPO_A)).toEqual(
      expect.objectContaining({ attempted: 2, conflicts: 0, failed: 0, reverted: 2 })
    );
    expect(byRoot.get(REPO_B)).toEqual(
      expect.objectContaining({ attempted: 1, conflicts: 0, failed: 0, reverted: 1 })
    );
    expect(byRoot.get(PLAIN_C)).toEqual(
      expect.objectContaining({ attempted: 1, conflicts: 0, failed: 0, reverted: 1 })
    );
    for (const outcome of result.rootOutcomes) {
      expect(outcome.rootPath).not.toBeNull();
    }

    // Redo brings back everything — INCLUDING the shell-created lockfile.
    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
    expect(await readDiskFile(rootPath(REPO_A), '/generated/package-lock.json')).toBe(
      '{ "lock": 1 }'
    );
  });

  it('a post-preview drift in ONE root blocks every other root too', async () => {
    await previewFor('msg-2');
    await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'hand edited in repo B');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe('conflicts-unacknowledged');
      expect(refused.conflicts).toHaveLength(1);
      expect(refused.conflicts[0]?.rootId).toBe(REPO_B);
      expect(refused.conflicts[0]?.path).toBe('src/index.ts');
      expect(refused.conflicts[0]?.rootLabel).toBe(`Root ${REPO_B}`);
    }
    // The other two roots are untouched — no per-root partial apply.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');

    const acknowledged = await applyRewind(
      fixture.db,
      {
        acknowledgeConflicts: true,
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      },
      deps
    );
    expect(acknowledged.ok).toBe(true);
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
  });

  it('a disconnected root is reported by name, never silently skipped', async () => {
    await disconnectRoot(fixture.db, PLAIN_C);
    await previewFor('msg-2');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      deps
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.conflicts).toHaveLength(1);
      expect(refused.conflicts[0]?.code).toBe('root-unavailable');
      expect(refused.conflicts[0]?.rootId).toBe(PLAIN_C);
      expect(refused.conflicts[0]?.message).toContain('no longer connected');
    }
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');

    const applied = await applyRewind(
      fixture.db,
      {
        acknowledgeConflicts: true,
        messageId: 'msg-2',
        mode: 'conversation-and-files',
        threadId: THREAD_ID,
      },
      deps
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    // The connected roots restore; the disconnected one still appears in the
    // roll-up, with a null path and its named conflict — never omitted.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
    const byRoot = new Map(applied.rootOutcomes.map((outcome) => [outcome.rootId, outcome]));
    expect(byRoot.get(PLAIN_C)).toEqual(
      expect.objectContaining({
        attempted: 0,
        conflicts: 1,
        failed: 0,
        reverted: 0,
        rootId: PLAIN_C,
        rootPath: null,
      })
    );
    // And its disk is untouched.
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
  });

  it('a mid-loop restore throw becomes an honest per-root failed outcome — the batch and recorded pre-reverts survive and redo works', async () => {
    await previewFor('msg-2');

    // Shadow-git dies for REPO_B's pre-revert capture only — the other roots
    // must restore, the tombstone batch must survive, and the result must be
    // the structured per-root roll-up, never an unstructured throw that
    // strands the batch with no redo handle.
    const failingDeps: RewindServiceDeps = {
      ...deps,
      snapshotService: {
        ...deps.snapshotService,
        snapshot: (handle, meta) => {
          if (handle.rootId === REPO_B && meta.kind === 'pre-revert') {
            return Promise.reject(new Error('shadow git unavailable for repo B'));
          }
          return deps.snapshotService.snapshot(handle, meta);
        },
      },
    };

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      failingDeps
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The healthy roots restored; the failing root's disk is UNTOUCHED (its
    // throw came before any byte of it moved).
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
    // The batch exists and the failure is a NAMED per-root outcome.
    expect(result.tombstonedMessageIds.length).toBeGreaterThan(0);
    const byRoot = new Map(result.rootOutcomes.map((outcome) => [outcome.rootId, outcome]));
    expect(byRoot.get(REPO_B)).toEqual(
      expect.objectContaining({ failed: 1, reverted: 0, rootId: REPO_B })
    );
    const failedOutcome = result.fileOutcomes.find(
      (outcome) => outcome.rootId === REPO_B && outcome.code !== 'reverted'
    );
    expect(failedOutcome?.message).toContain('shadow git unavailable for repo B');

    // Redo remains possible over the roots whose pre-revert snapshots WERE
    // recorded; the failed root (never mutated) stays as the user left it.
    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, deps);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
  });
});
