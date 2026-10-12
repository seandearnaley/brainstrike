/**
 * Real-git coverage for the W7 snapshot changeset resolution (BST-1164 T2):
 * the turn-boundary triggers + `changeset-snapshot-view.ts` end to end over
 * REAL temp roots and the production `execFileSnapshotGitRunner` (house
 * pattern of `snapshot-service.integration.test.ts`).
 *
 * THE MULTI-ROOT BAR (plan global constraint 7): every scenario runs over
 * TWO git roots + ONE plain (non-git) root, and the shell-side-effect
 * fixture — a file created by a DIRECT `fs` write, never a tool — MUST
 * appear in the turn's changeset. This is the fixture class the journal
 * engine structurally could not pass.
 *
 * Also pinned here:
 * - the LIVE Last Turn view (worktree side) shows mid-turn edits with ZERO
 *   database reads (the BST-1169 starvation rule) and no turn-end snapshot;
 * - totals are REAL numbers (numstat sums), never the journal's null;
 * - a legacy ledger turn has no attribution source, so no file carries
 *   `toolAttributed` (host turns attribute from their committed log);
 * - failed captures and pre-engine turns resolve to typed, honest errors —
 *   never a partial diff (plan global constraint 4);
 * - `fileDiff` disambiguates the same relative path across roots by rootId;
 * - `run-range` spans turns (from turn's start ↔ to turn's end).
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitResult } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSnapshotChangesetResolver,
  type SnapshotChangesetResolver,
  type SnapshotRunAnchor,
} from '../../assistant-server/changeset-snapshot-view';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import {
  FAILED_SNAPSHOT_CAPTURE_OID,
  type InsertWorkspaceSnapshotInput,
  type SnapshotRepository,
  type WorkspaceSnapshotRow,
} from '../../assistant-server/snapshot-repository';
import { createSnapshotService } from '../../assistant-server/snapshot-service';
import {
  createTurnBoundaryController,
  type TurnBoundaryController,
} from '../../assistant-server/snapshot-turn-boundaries';
import {
  createSnapshotTurnRegistry,
  type SnapshotTurnRegistry,
} from '../../assistant-server/snapshot-turn-registry';

const execFileAsync = promisify(execFile);
const HEAVY_TIMEOUT_MS = 60_000;
const THREAD = 'thread-1';

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink never trips path math.
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

async function makeGitRoot(prefix: string): Promise<string> {
  const root = await makeTempDir(prefix);
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: root });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, content, 'utf8');
}

/** In-memory SnapshotRepository with mint-ordered lexicographic timestamps. */
function makeLedger() {
  const rows: WorkspaceSnapshotRow[] = [];
  let counter = 0;
  let reads = 0;
  const repository: SnapshotRepository = {
    deleteByIds: () => {
      throw new Error('deleteByIds is not under test');
    },
    deleteForThread: () => {
      throw new Error('deleteForThread is not under test');
    },
    insertSnapshot: (input: InsertWorkspaceSnapshotInput) => {
      counter += 1;
      const row: WorkspaceSnapshotRow = {
        commitOid: input.commitOid,
        createdAt: String(counter).padStart(8, '0'),
        id: `row-${counter}`,
        kind: input.kind,
        rootId: input.rootId,
        rootPath: input.rootPath,
        runId: input.runId ?? null,
        threadId: input.threadId,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    latestSnapshotFor: () => {
      throw new Error('latestSnapshotFor is not under test');
    },
    rootsForThread: () => {
      throw new Error('rootsForThread is not under test');
    },
    snapshotsForThread: (threadId: string) => {
      reads += 1;
      return Promise.resolve(rows.filter((row) => row.threadId === threadId));
    },
  };
  return { readCount: () => reads, repository, rows };
}

interface Harness {
  readonly controller: TurnBoundaryController;
  readonly dbReadCount: () => number;
  readonly ledgerReadCount: () => number;
  readonly registry: SnapshotTurnRegistry;
  readonly resolver: SnapshotChangesetResolver;
  readonly rows: WorkspaceSnapshotRow[];
}

interface HarnessOptions {
  readonly runAnchors?: Readonly<Record<string, SnapshotRunAnchor>>;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const snapshotsBaseDir = await makeTempDir('brainstrike-w7t2-shadow-');
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir,
  });
  const registry = createSnapshotTurnRegistry();
  const { readCount, repository, rows } = makeLedger();
  let dbReads = 0;
  // The database handle is a COUNTER, never a real DB: everything DB-bound
  // is injected (the `readRunAnchor` fake below), so any query
  // through this object is a bug in the module under test.
  const db: EditCheckpointDatabase = {
    query: () => {
      throw new Error('the snapshot view must not run raw SQL in these tests');
    },
  };
  const resolveDatabase = () => {
    dbReads += 1;
    return Promise.resolve(db);
  };
  const controller = createTurnBoundaryController({
    registry,
    resolveDatabase,
    snapshots: { createRepository: () => repository, service },
  });
  const resolver = createSnapshotChangesetResolver({
    createRepository: () => repository,
    readRunAnchor: (_db, _threadId, runId): Promise<GitResult<SnapshotRunAnchor | null>> =>
      Promise.resolve({ ok: true, value: options.runAnchors?.[runId] ?? null }),
    registry,
    resolveDatabase,
    resolveService: () => service,
  });
  return {
    controller,
    dbReadCount: () => dbReads,
    ledgerReadCount: readCount,
    registry,
    resolver,
    rows,
  };
}

interface MultiRootFixture {
  readonly gitA: string;
  readonly gitB: string;
  readonly plainC: string;
  readonly roots: readonly { readonly path: string; readonly rootId: string }[];
}

async function makeMultiRootFixture(): Promise<MultiRootFixture> {
  const gitA = await makeGitRoot('brainstrike-w7t2-git-a-');
  const gitB = await makeGitRoot('brainstrike-w7t2-git-b-');
  const plainC = await makeTempDir('brainstrike-w7t2-plain-c-');
  await write(gitA, 'src/index.ts', 'v1 line\n');
  await execFileAsync('git', ['add', '-A'], { cwd: gitA });
  await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: gitA });
  await write(gitB, 'README.md', 'git b\n');
  await write(plainC, 'notes.txt', 'plain v1\n');
  return {
    gitA,
    gitB,
    plainC,
    roots: [
      { path: gitA, rootId: 'root-a' },
      { path: gitB, rootId: 'root-b' },
      { path: plainC, rootId: 'root-c' },
    ],
  };
}

function agentRun(runId: string) {
  return { kind: 'agent-run' as const, runId, threadId: THREAD };
}

describe('changeset-snapshot-view — multi-root settled turn (the headline bar)', () => {
  it(
    'a turn over 2 git roots + 1 plain root captures the tool edit, the SHELL-created file, and the plain-root edit, with REAL totals and no attribution',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness();

      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      // Mid-turn mutations. NONE of these go through a tool seam:
      await write(fixture.gitA, 'src/index.ts', 'v1 line\nv2 line added by tool\n');
      await write(fixture.gitB, 'shell-note.txt', 'created by a direct fs write\n');
      await write(fixture.plainC, 'notes.txt', 'plain v2\n');
      await write(fixture.plainC, 'new-plain.txt', 'brand new in the plain root\n');
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-1',
        status: 'completed',
        threadId: THREAD,
      });

      const result = await harness.resolver.resolveView(agentRun('run-1'));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const byKey = new Map(
        result.value.files.map((file) => [`${file.rootId}:${file.path}`, file])
      );

      // The tool edit (gitA).
      expect(byKey.get('root-a:src/index.ts')).toMatchObject({ status: 'modified' });
      // THE BAR: the shell-created file (gitB) appears.
      expect(byKey.get('root-b:shell-note.txt')).toMatchObject({
        additions: 1,
        status: 'added',
      });
      // A legacy ledger turn has no attribution source: no file claims one.
      for (const file of result.value.files) {
        expect(file).not.toHaveProperty('toolAttributed');
      }
      // The plain (non-git) root's edit and addition both appear.
      expect(byKey.get('root-c:notes.txt')?.status).toBe('modified');
      expect(byKey.get('root-c:new-plain.txt')?.status).toBe('added');

      // REAL totals — the numstat sum, never the journal's null.
      const expectedAdditions = result.value.files.reduce(
        (sum, file) => sum + (file.additions ?? 0),
        0
      );
      expect(result.value.totalAdditions).toBe(expectedAdditions);
      expect(result.value.totalAdditions).toBeGreaterThan(0);
      expect(result.value.totalDeletions).not.toBeNull();
      expect(typeof result.value.totalDeletions).toBe('number');
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    'fileDiff disambiguates the SAME relative path across two roots by rootId (multi-root identity)',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness();
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      await write(fixture.gitA, 'same.txt', 'content in git root A\n');
      await write(fixture.plainC, 'same.txt', 'content in plain root C\n');
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-1',
        status: 'completed',
        threadId: THREAD,
      });

      const inA = await harness.resolver.fileDiff('root-a', agentRun('run-1'), 'same.txt');
      const inC = await harness.resolver.fileDiff('root-c', agentRun('run-1'), 'same.txt');
      expect(inA.ok && inC.ok).toBe(true);
      if (!(inA.ok && inC.ok)) {
        return;
      }
      expect(inA.value.content).toMatchObject({
        kind: 'full',
        newContent: 'content in git root A\n',
      });
      expect(inC.value.content).toMatchObject({
        kind: 'full',
        newContent: 'content in plain root C\n',
      });
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('changeset-snapshot-view — LIVE Last Turn (worktree side)', () => {
  it(
    'shows mid-turn edits with NO turn-end snapshot and ZERO database reads (BST-1169 hot-path rule)',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness();
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      const ledgerReadsBefore = harness.ledgerReadCount();
      const dbReadsBefore = harness.dbReadCount();

      await write(fixture.gitB, 'mid-turn-shell.txt', 'appeared mid-run\n');
      const first = await harness.resolver.resolveView(agentRun('run-1'));
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(
        first.value.files.find(
          (file) => file.rootId === 'root-b' && file.path === 'mid-turn-shell.txt'
        )
      ).toMatchObject({ status: 'added' });
      // Attribution is DELIBERATELY absent on the live path (no DB reads).
      for (const file of first.value.files) {
        expect(file.toolAttributed).toBeUndefined();
      }

      // The live view GROWS as the turn continues — same changeset, re-resolved.
      await write(fixture.plainC, 'second-mid-turn.txt', 'later in the same run\n');
      const second = await harness.resolver.resolveView(agentRun('run-1'));
      expect(second.ok).toBe(true);
      if (!second.ok) {
        return;
      }
      expect(
        second.value.files.some(
          (file) => file.rootId === 'root-c' && file.path === 'second-mid-turn.txt'
        )
      ).toBe(true);
      expect(typeof second.value.totalAdditions).toBe('number');

      // ZERO database work on the hot path: no ledger rows read, no handle resolved.
      expect(harness.ledgerReadCount()).toBe(ledgerReadsBefore);
      expect(harness.dbReadCount()).toBe(dbReadsBefore);
      // And no turn-end rows exist yet — the turn is still open.
      expect(harness.rows.filter((row) => row.kind === 'turn-end')).toHaveLength(0);
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('changeset-snapshot-view — honest failure states', () => {
  it(
    'a failed turn-start capture resolves the WHOLE changeset to the typed capture-failed error (never a partial diff)',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness();
      // Make root-b's capture fail: replace its path with a nonexistent dir.
      const roots = [
        fixture.roots[0],
        { path: path.join(fixture.gitB, 'does-not-exist'), rootId: 'root-b' },
        fixture.roots[2],
      ].filter((root): root is { path: string; rootId: string } => root !== undefined);
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-1',
        status: 'completed',
        threadId: THREAD,
      });

      const result = await harness.resolver.resolveView(agentRun('run-1'));
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toMatch(/^changeset-snapshot-capture-failed:/);
      // The durable marker exists too (post-restart honesty).
      expect(
        harness.rows.some(
          (row) => row.rootId === 'root-b' && row.commitOid === FAILED_SNAPSHOT_CAPTURE_OID
        )
      ).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );

  it('a settled ledger bracket containing a SENTINEL row renders the typed capture-failed error', async () => {
    const harness = await makeHarness();
    // Hand-write a settled bracket whose turn-start capture failed (as a
    // fresh process would find it after a restart — registry empty).
    const insert = (input: InsertWorkspaceSnapshotInput) =>
      harness.rows.push({
        commitOid: input.commitOid,
        createdAt: String(harness.rows.length + 1).padStart(8, '0'),
        id: `row-${harness.rows.length + 1}`,
        kind: input.kind,
        rootId: input.rootId,
        rootPath: input.rootPath,
        runId: input.runId ?? null,
        threadId: input.threadId,
      });
    insert({
      commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/ws/a',
      runId: 'run-1',
      threadId: THREAD,
    });
    insert({
      commitOid: 'c'.repeat(40),
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/ws/a',
      runId: 'run-1',
      threadId: THREAD,
    });

    const result = await harness.resolver.resolveView(agentRun('run-1'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^changeset-snapshot-capture-failed:/);
  });

  it('a PRE-ENGINE turn (no snapshot rows at all) renders the typed snapshot-missing error', async () => {
    const harness = await makeHarness({
      runAnchors: { 'run-old': { completedAt: '00000001', startedAt: '00000000' } },
    });
    const result = await harness.resolver.resolveView(agentRun('run-old'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^changeset-snapshot-missing:/);
  });

  it('an unknown run id renders the run-anchor-missing error (reused journal-engine prefix)', async () => {
    const harness = await makeHarness();
    // One settled bracket exists, but the requested run matches nothing and
    // the runs table knows no such run.
    const insert = (input: InsertWorkspaceSnapshotInput) =>
      harness.rows.push({
        commitOid: input.commitOid,
        createdAt: String(harness.rows.length + 1).padStart(8, '0'),
        id: `row-${harness.rows.length + 1}`,
        kind: input.kind,
        rootId: input.rootId,
        rootPath: input.rootPath,
        runId: input.runId ?? null,
        threadId: input.threadId,
      });
    insert({
      commitOid: 'a'.repeat(40),
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/ws/a',
      runId: 'run-1',
      threadId: THREAD,
    });
    insert({
      commitOid: 'b'.repeat(40),
      kind: 'turn-end',
      rootId: 'root-a',
      rootPath: '/ws/a',
      runId: 'run-1',
      threadId: THREAD,
    });
    const result = await harness.resolver.resolveView(agentRun('run-ghost'));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/^run-anchor-missing:/);
  });
});

describe('changeset-snapshot-view — turns are not runs', () => {
  it(
    'a settled MID-TURN resume run id resolves to its turn via the run-row timestamp fallback (cold path)',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness({
        // 'run-mid' appears on NO snapshot row; its timestamps sit inside the
        // first (and only) bracket: started after the bracket opened
        // (createdAt '00000001'…) and completed before any later bracket.
        runAnchors: { 'run-mid': { completedAt: '00000099', startedAt: '00000002' } },
      });
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      await write(fixture.gitA, 'src/index.ts', 'v1 line\nresumed edit\n');
      // The approval-resume leg attaches, then ends the turn.
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: true,
        roots: fixture.roots,
        runId: 'run-2',
        threadId: THREAD,
      });
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-2',
        status: 'completed',
        threadId: THREAD,
      });
      // Force the ledger path: a fresh process would have an empty registry.
      harness.registry.clear();

      const result = await harness.resolver.resolveView(agentRun('run-mid'));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(
        result.value.files.some((file) => file.rootId === 'root-a' && file.path === 'src/index.ts')
      ).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    'run-range spans turns: FROM turn-start of the first turn TO turn-end of the second',
    async () => {
      const fixture = await makeMultiRootFixture();
      const harness = await makeHarness();
      // Turn 1 (run-1): modify gitA.
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-1',
        threadId: THREAD,
      });
      await write(fixture.gitA, 'src/index.ts', 'v1 line\nturn one\n');
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-1',
        status: 'completed',
        threadId: THREAD,
      });
      // Turn 2 (run-2): modify gitA again + shell file in gitB.
      await harness.controller.beginLeg({
        anchorMessageId: 'msg-2',
        isResume: false,
        roots: fixture.roots,
        runId: 'run-2',
        threadId: THREAD,
      });
      await write(fixture.gitA, 'src/index.ts', 'v1 line\nturn one\nturn two\n');
      await write(fixture.gitB, 'range-shell.txt', 'shell write in turn two\n');
      await harness.controller.completeLeg({
        paused: false,
        runId: 'run-2',
        status: 'completed',
        threadId: THREAD,
      });
      harness.registry.clear();

      const result = await harness.resolver.resolveView({
        fromRunId: 'run-1',
        kind: 'run-range',
        threadId: THREAD,
        toRunId: 'run-2',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const gitAEntry = result.value.files.find(
        (file) => file.rootId === 'root-a' && file.path === 'src/index.ts'
      );
      // BOTH turns' lines are in the range diff (start of turn 1 → end of turn 2).
      expect(gitAEntry?.additions).toBe(2);
      expect(
        result.value.files.some(
          (file) => file.rootId === 'root-b' && file.path === 'range-shell.txt'
        )
      ).toBe(true);
      expect(typeof result.value.totalAdditions).toBe('number');
    },
    HEAVY_TIMEOUT_MS
  );
});
