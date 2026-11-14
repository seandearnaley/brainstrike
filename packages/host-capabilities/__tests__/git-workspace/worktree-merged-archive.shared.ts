/**
 * The archive-on-merge suites' host (BST-2504): the worktree service over real git and a real
 * state store, with the idle cap after its creates, and the git a merge needs.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostIdleWorktreeArchive } from '@brainstrike/agent-host';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { StateStore } from '@brainstrike/state-store';
import type { ManagedWorktreeRow, WorktreeCreateParams } from '@brainstrike/types';
import { afterEach, beforeEach, expect } from 'vitest';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import type { GitCommandRunner } from '../../src/git-workspace/git-service.ts';
import { createIdleWorktreeCap } from '../../src/git-workspace/worktree-idle-cap.ts';
import { createWorktreeLedger } from '../../src/git-workspace/worktree-ledger.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

export interface ListedThread {
  readonly binding: ThreadWorkspaceBinding | null;
  readonly hasRun: boolean;
  readonly threadId: string;
}

export const IDENTITY = [
  '-c',
  'user.email=test@brainstrike.invalid',
  '-c',
  'user.name=BrainStrike Test',
];

/** The worktrees a test checks are made for `thread-2`'s run unless it says otherwise. */
export const MADE_BY_THREAD_2 = { runId: 'run-2', threadId: 'thread-2' } as const;

/** What a test reads and changes; reset before each test. */
interface MergedArchiveState {
  /** Runs as the pass asks the service to archive a worktree, before the archive's turn. */
  beforeArchive: ((worktreeId: string) => void) | undefined;
  db: StateStore;
  managedDirectory: string;
  repo: string;
  /** Git as the host runs it; a test may answer one command differently. */
  run: GitCommandRunner;
  running: Set<string>;
  threads: ListedThread[];
  told: HostIdleWorktreeArchive[];
}

/** Registers the suite's hooks; call it inside the suite's `describe`. */
export function mergedArchiveHarness() {
  const workspace = createTestWorkspace();
  const state = {} as MergedArchiveState;

  beforeEach(async () => {
    state.db = await StateStore.open(workspace.freshTempDir('bst-merged-archive-state-'));
    state.repo = workspace.freshRepo('merged-archive-repo');
    state.managedDirectory = workspace.freshManagedDir();
    state.threads = [
      { binding: null, hasRun: true, threadId: 'thread-1' },
      { binding: null, hasRun: true, threadId: 'thread-2' },
    ];
    state.running = new Set();
    state.told = [];
    state.run = execFileGitRunner;
    state.beforeArchive = undefined;
  });

  afterEach(async () => {
    await state.db.close();
    workspace.cleanup();
  });

  /** The service with the cap after its creates; `setup` runs as each worktree's setup. */
  function host(setup?: (worktree: ManagedWorktreeRow) => void) {
    const started: Promise<void>[] = [];
    const ledger = createWorktreeLedger(
      async () => state.db,
      async (id) => state.running.has(id)
    );
    const cap = createIdleWorktreeCap({
      archive: (params) => {
        state.beforeArchive?.(params.worktreeId);
        return service.archive(params);
      },
      listActive: () => ledger.listActive(),
      listRepository: (repoCommonDir) => ledger.listForRepository(repoCommonDir),
      listThread: (threadId) => ledger.listForThread(threadId),
      publish: (archive) => {
        state.told.push(archive);
      },
      readBaseCommit: (worktreeId) => ledger.baseCommit(worktreeId),
      readRoots: async () => [],
      readThreads: async () => state.threads,
      run: (params) => state.run(params),
    });
    const service = buildTestService(
      { db: state.db, managedDirectory: state.managedDirectory, repo: state.repo },
      {
        afterCreate: (worktree, params) => {
          started.push(cap.afterCreate(worktree, params));
        },
        hasRunningThread: async (id) => state.running.has(id),
        ...(setup
          ? {
              runSetup: async ({ worktree }) => {
                setup(worktree);
                return {
                  copiedPaths: [],
                  output: '',
                  reason: null,
                  skippedCopies: [],
                  status: 'none' as const,
                  truncated: false,
                };
              },
            }
          : {}),
      }
    );

    /** A worktree on `bs/<name>` from `baseRef` (`main`), made for `thread-2`'s run by default. */
    async function make(
      name: string,
      provenance: Pick<WorktreeCreateParams, 'runId' | 'threadId'> = MADE_BY_THREAD_2,
      baseRef = 'main'
    ): Promise<ManagedWorktreeRow> {
      const created = await service.create({
        baseRef,
        branch: { name: `bs/${name}` },
        createdBy: 'agent',
        name,
        rootId: 'r-1',
        ...provenance,
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      await Promise.all(started);
      return created.value.worktree;
    }

    return { cap, make };
  }

  function commit(cwd: string, file: string, content: string, message: string): void {
    writeFileSync(path.join(cwd, file), content);
    git(cwd, ['add', '--', file]);
    git(cwd, [...IDENTITY, 'commit', '-m', message]);
  }

  /** The person fetched: the local view of `origin`'s default branch is `main`. */
  function fetchMain(): void {
    git(state.repo, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
  }

  /** A branch `feat` off `main` with one commit of its own; the checkout stays on `main`. */
  function featureBranch(): void {
    git(state.repo, ['checkout', '--quiet', '-b', 'feat']);
    commit(state.repo, 'feature.ts', 'export const feature = 1;\n', 'feature work');
    git(state.repo, ['checkout', '--quiet', 'main']);
  }

  /** A worktree whose branch has a commit of its own, squash-merged into `main` and fetched. */
  async function squashMerged(
    make: (name: string) => Promise<ManagedWorktreeRow>,
    name: string
  ): Promise<ManagedWorktreeRow> {
    const worktree = await make(name);
    commit(worktree.path, `${name}.ts`, `export const ${name.replaceAll('-', '_')} = 1;\n`, name);
    git(state.repo, ['merge', '--squash', `bs/${name}`]);
    git(state.repo, [...IDENTITY, 'commit', '-m', `${name} (#1)`]);
    fetchMain();
    return worktree;
  }

  async function ledgerRow(id: string): Promise<ManagedWorktreeRow> {
    const row = (await state.db.worktreeLedger({ id, operation: 'get' })).rows[0];
    if (!row) {
      throw new Error(`No ledger row ${id}`);
    }
    return row;
  }

  /** Archived as the idle cap archives: its snapshot ref recorded and in git, its branch kept. */
  async function expectArchived(row: ManagedWorktreeRow): Promise<void> {
    const archived = await ledgerRow(row.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archiveSnapshotRef).toBe(`refs/brainstrike/worktree-archive/${row.id}`);
    expect(existsSync(row.path)).toBe(false);
    expect(
      git(state.repo, ['cat-file', '-t', `refs/brainstrike/worktree-archive/${row.id}`]).trim()
    ).toBe('commit');
    expect(git(state.repo, ['branch', '--list', row.branch ?? '']).trim()).not.toBe('');
  }

  async function expectKept(row: ManagedWorktreeRow): Promise<void> {
    expect((await ledgerRow(row.id)).archivedAt).toBeNull();
    expect(existsSync(row.path)).toBe(true);
  }

  /** The notice the thread that made `row` is told. */
  function mergedNotice(row: ManagedWorktreeRow, threadId = 'thread-2'): HostIdleWorktreeArchive {
    return {
      defaultBranch: 'origin/main',
      reason: 'merged',
      threadId,
      worktrees: [
        {
          branch: row.branch ?? '',
          name: path.basename(row.path),
          snapshotRef: `refs/brainstrike/worktree-archive/${row.id}`,
          worktreeId: row.id,
        },
      ],
    };
  }

  return {
    commit,
    expectArchived,
    expectKept,
    featureBranch,
    fetchMain,
    host,
    mergedNotice,
    squashMerged,
    state,
    tempDir: (prefix: string) => workspace.freshTempDir(prefix),
  };
}
