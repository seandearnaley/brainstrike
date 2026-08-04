/**
 * MULTI-ROOT BAR for Conversation Rewind (BST-1115, W5 T3) — the user's
 * headline requirement.
 *
 * A single run range spans edits in TWO git repositories PLUS one file that
 * lives outside any repository (a mounted folder with no `.git`). Revert must
 * restore all three correctly, report PER-ROOT outcomes, and never
 * partially-silently-skip a root — including a root that has since been
 * disconnected, which must surface as a named conflict rather than a quiet
 * omission.
 *
 * Rewind is journal-driven and git-agnostic by construction; this suite is
 * what proves it, rather than asserting it.
 *
 * MUTATION-VERIFIED — see the task report for the mutation list.
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

import { applyRewind, redoRewind } from '../../assistant-server/rewind-service';
import {
  cleanupTempDirs,
  createReindexProbe,
  createRewindFixture,
  disconnectRoot,
  insertMessage,
  insertRun,
  makeGitRepo,
  makeTempDir,
  type ReindexProbe,
  type RewindFixture,
  readDiskFile,
  seedWrite,
  THREAD_ID,
  writeDiskFile,
} from './rewind-service-test-support';

const REPO_A = 'root-repo-a';
const REPO_B = 'root-repo-b';
/** Mounted folder that is NOT a git repository — the "out-of-repo file". */
const PLAIN_C = 'root-plain-c';

let fixture: RewindFixture;
let probe: ReindexProbe;

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
  await insertRun(fixture.db, { id: 'run-1', startedAt: '2026-02-01T00:00:10Z' });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:11Z', id: 'msg-2' });
  await insertRun(fixture.db, { id: 'run-2', startedAt: '2026-02-01T00:00:20Z' });
  await insertMessage(fixture.db, { createdAt: '2026-02-01T00:00:21Z', id: 'msg-3' });
}

/**
 * The same RELATIVE path in both repos plus a third file outside any repo, all
 * inside one range — two runs deep in repo A so ordering matters here too.
 */
async function seedThreeRootEdits(): Promise<void> {
  await seedWrite(fixture, {
    after: 'a-v1',
    before: 'a-v0',
    occurredAt: '2026-02-01T00:00:12Z',
    path: '/src/index.ts',
    rootId: REPO_A,
    runId: 'run-1',
  });
  await seedWrite(fixture, {
    after: 'b-v1',
    before: 'b-v0',
    occurredAt: '2026-02-01T00:00:13Z',
    path: '/src/index.ts',
    rootId: REPO_B,
    runId: 'run-1',
  });
  await seedWrite(fixture, {
    after: 'c-v1',
    before: 'c-v0',
    occurredAt: '2026-02-01T00:00:14Z',
    path: '/notes/scratch.md',
    rootId: PLAIN_C,
    runId: 'run-1',
  });
  await seedWrite(fixture, {
    after: 'a-v2',
    before: 'a-v1',
    occurredAt: '2026-02-01T00:00:22Z',
    path: '/src/index.ts',
    rootId: REPO_A,
    runId: 'run-2',
  });
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
  await seedThread();
});

afterEach(async () => {
  await fixture.db.close();
  await cleanupTempDirs();
});

describe('applyRewind — multi-root range', () => {
  it('restores two repositories and one out-of-repo file, reporting every root', async () => {
    await seedThreeRootEdits();

    const result = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Same relative path in two repos must NOT collapse into one file.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
    // The file outside any git repository restores identically.
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v0');
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

    const redone = await redoRewind(fixture.db, { rewindId: result.rewindId }, probe);
    expect(redone.ok).toBe(true);
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v1');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
  });

  it('a conflict in ONE root blocks every other root too', async () => {
    await seedThreeRootEdits();
    await writeDiskFile(rootPath(REPO_B), '/src/index.ts', 'hand edited in repo B');

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.conflicts).toHaveLength(1);
      expect(refused.conflicts[0]?.rootId).toBe(REPO_B);
      expect(refused.conflicts[0]?.path).toBe('/src/index.ts');
      expect(refused.conflicts[0]?.rootLabel).toBe(`Root ${REPO_B}`);
    }
    // The other two roots are untouched — no per-root partial apply.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v2');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
  });

  it('a disconnected root is reported by name, never silently skipped', async () => {
    await seedThreeRootEdits();
    await disconnectRoot(fixture.db, PLAIN_C);

    const refused = await applyRewind(
      fixture.db,
      { messageId: 'msg-2', mode: 'conversation-and-files', threadId: THREAD_ID },
      probe
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.conflicts).toHaveLength(1);
      expect(refused.conflicts[0]?.code).toBe('root-unavailable');
      expect(refused.conflicts[0]?.rootId).toBe(PLAIN_C);
      expect(refused.conflicts[0]?.path).toBe('/notes/scratch.md');
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
      probe
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) {
      return;
    }
    // The connected roots revert; the disconnected one still appears in the
    // roll-up, with a null path and a failed count — never omitted.
    expect(await readDiskFile(rootPath(REPO_A), '/src/index.ts')).toBe('a-v0');
    expect(await readDiskFile(rootPath(REPO_B), '/src/index.ts')).toBe('b-v0');
    const byRoot = new Map(applied.rootOutcomes.map((outcome) => [outcome.rootId, outcome]));
    expect(byRoot.has(PLAIN_C)).toBe(true);
    expect(byRoot.get(PLAIN_C)).toEqual(
      expect.objectContaining({
        attempted: 1,
        conflicts: 1,
        failed: 1,
        reverted: 0,
        rootId: PLAIN_C,
        rootPath: null,
      })
    );
    const plainOutcome = applied.fileOutcomes.find((outcome) => outcome.rootId === PLAIN_C);
    expect(plainOutcome?.path).toBe('/notes/scratch.md');
    expect(plainOutcome?.code).toBe('not_revertible');
    expect(await readDiskFile(rootPath(PLAIN_C), '/notes/scratch.md')).toBe('c-v1');
  });
});
