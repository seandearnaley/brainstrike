// @vitest-environment node

/**
 * ADR-0034 Automatic isolation, the platform's part, over real git and a real
 * state store: the worktree a host makes for a thread starts from the
 * checkout's last commit and is recorded as the agent's, and a checkout's
 * uncommitted paths are the ones git reports.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostCheckoutIsolation } from '../../src/git-workspace/checkout-isolation.ts';
import { gitRefused } from '../../src/git-workspace/git-failure.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import { createGitService } from '../../src/git-workspace/git-service.ts';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared.ts';

describe('the host isolates a checkout (real git + real SQLite)', () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();
  const opened: string[] = [];
  const signal = new AbortController().signal;

  const isolation = (folder = repo) => {
    const service = buildTestService({ db, managedDirectory, repo: folder });
    const built = hostCheckoutIsolation({
      repository: () => createGitService({ cwd: folder, run: execFileGitRunner }).repository(),
      services: {
        openWorktreeFolder: async (worktreePath) => {
          opened.push(worktreePath);
          return {
            displayName: path.basename(worktreePath),
            path: worktreePath,
            rootId: 'worktree-root',
          };
        },
        resolveWorktreeService: () => service,
      },
      status: () => createGitService({ cwd: folder, run: execFileGitRunner }).status(),
    });
    if (!built) {
      throw new Error('A host that opens worktrees as folders isolates checkouts');
    }
    return built;
  };

  beforeEach(async () => {
    opened.length = 0;
    db = await StateStore.open(workspace.freshTempDir('bst-isolation-state-'));
    repo = workspace.freshRepo('repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it("makes a worktree from the last commit, without the checkout's uncommitted work, as the run's", async () => {
    writeFileSync(path.join(repo, 'hello.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(repo, 'draft.ts'), 'export const draft = true;\n');

    const worktree = await isolation().create({
      rootId: 'r-1',
      runId: 'run-7',
      signal,
      threadId: 'thread-7',
    });
    if ('noWorktree' in worktree) {
      throw new Error('A repository has a checkout to make a worktree of');
    }

    // The last commit's file, and nothing another thread left uncommitted in the checkout.
    expect(readFileSync(path.join(worktree.root.path, 'hello.ts'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
    expect(existsSync(path.join(worktree.root.path, 'draft.ts'))).toBe(false);
    // A branch of its own, named after the worktree, for the person to merge.
    const name = path.basename(worktree.root.path);
    expect(worktree.branch).toBe(`bs/${name}`);
    expect(git(worktree.root.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      `bs/${name}`
    );
    expect(git(worktree.root.path, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'main']));
    // Opened as a folder, and it returns to the checkout it was made from.
    expect(opened).toEqual([worktree.root.path]);
    expect(worktree).toMatchObject({ localRootId: 'r-1', root: { rootId: 'worktree-root' } });
    // The ledger says the agent made it, in this run of this thread.
    const { rows } = await db.worktreeLedger({ operation: 'list-active' });
    expect(rows).toEqual([
      expect.objectContaining({
        baseRef: 'HEAD',
        createdBy: 'agent',
        id: worktree.worktreeId,
        runId: 'run-7',
        threadId: 'thread-7',
      }),
    ]);
  });

  it('names the paths that differ from the last commit, and no others', async () => {
    writeFileSync(path.join(repo, 'kept.ts'), 'export const kept = true;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'kept']);
    writeFileSync(path.join(repo, 'hello.ts'), 'export const value = 2;\n');
    writeFileSync(path.join(repo, 'new.ts'), 'export const fresh = true;\n');
    rmSync(path.join(repo, 'kept.ts'));
    git(repo, ['add', 'new.ts']);

    await expect(
      isolation().uncommitted({
        paths: ['hello.ts', 'new.ts', 'kept.ts', 'never-touched.ts'],
        rootId: 'r-1',
        signal,
      })
    ).resolves.toEqual(['hello.ts', 'new.ts', 'kept.ts']);

    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'all of it']);
    await expect(
      isolation().uncommitted({ paths: ['hello.ts', 'new.ts', 'kept.ts'], rootId: 'r-1', signal })
    ).resolves.toEqual([]);
  });

  it('names a path inside a nested repository, which git reports as one folder', async () => {
    const nested = path.join(repo, 'vendor', 'tool');
    mkdirSync(nested, { recursive: true });
    git(nested, ['init', '-b', 'main']);
    writeFileSync(path.join(nested, 'inner.ts'), 'export const inner = true;\n');

    // Git's status has the one entry `vendor/tool/` for everything in it.
    await expect(
      isolation().uncommitted({
        paths: ['vendor/tool/inner.ts', 'vendor/other.ts', 'hello.ts'],
        rootId: 'r-1',
        signal,
      })
    ).resolves.toEqual(['vendor/tool/inner.ts']);
  });

  it('names a path whose name git reports in another Unicode form', async () => {
    // "é" as e and a combining accent, the form a tool given that name writes it in.
    const decomposed = 'café.ts';
    writeFileSync(path.join(repo, decomposed), 'export const cafe = true;\n');

    // On macOS git reports the name precomposed; the edit record holds it as it was written.
    await expect(
      isolation().uncommitted({ paths: [decomposed, 'hello.ts'], rootId: 'r-1', signal })
    ).resolves.toEqual([decomposed]);
  });

  /** Nothing was made for the folder: no worktree on disk or in the ledger, and no folder opened. */
  const madeNothing = async (repository?: string): Promise<void> => {
    expect(opened).toEqual([]);
    expect((await db.worktreeLedger({ operation: 'list-active' })).rows).toEqual([]);
    if (repository) {
      expect(
        git(repository, ['worktree', 'list', '--porcelain']).match(/^worktree /gmu)
      ).toHaveLength(1);
      expect(git(repository, ['branch', '--list', 'bs/*'])).toBe('');
    }
  };

  it('has no worktree to make when git cannot read the folder on this machine', async () => {
    const service = buildTestService({ db, managedDirectory, repo });
    const built = hostCheckoutIsolation({
      // As the git runner reports a spawn that found no `git` on PATH.
      repository: async () => gitRefused('configuration', 'git.not-installed', 'spawn git ENOENT'),
      services: {
        openWorktreeFolder: async (worktreePath) => {
          opened.push(worktreePath);
          return { displayName: 'worktree', path: worktreePath, rootId: 'worktree-root' };
        },
        resolveWorktreeService: () => service,
      },
      status: () => createGitService({ cwd: repo, run: execFileGitRunner }).status(),
    });
    if (!built) {
      throw new Error('A host that opens worktrees as folders isolates checkouts');
    }

    // Not a refused edit: with no git to ask, its threads share the folder, as before Automatic.
    await expect(
      built.create({ rootId: 'r-1', runId: 'run-7', signal, threadId: 'thread-7' })
    ).resolves.toEqual({ noWorktree: 'git-unavailable' });
    expect(opened).toEqual([]);
    expect((await db.worktreeLedger({ operation: 'list-active' })).rows).toEqual([]);
  });

  it('has no worktree to make when the folder is not a git repository', async () => {
    const folder = workspace.freshTempDir('bst-isolation-plain-');

    // Not a failure: there is no checkout here, so the host leaves its threads sharing the folder.
    await expect(
      isolation(folder).create({ rootId: 'r-1', runId: 'run-7', signal, threadId: 'thread-7' })
    ).resolves.toEqual({ noWorktree: 'not-a-repository' });
    await madeNothing();
  });

  it('has no worktree to make when the repository has no commit yet', async () => {
    const unborn = workspace.freshTempDir('bst-isolation-unborn-');
    git(unborn, ['init', '-b', 'main']);
    writeFileSync(path.join(unborn, 'first.ts'), 'export const first = true;\n');

    // A worktree starts from the last commit, and there is none: `git worktree add` would fail.
    await expect(
      isolation(unborn).create({ rootId: 'r-1', runId: 'run-7', signal, threadId: 'thread-7' })
    ).resolves.toEqual({ noWorktree: 'no-commit-yet' });
    await madeNothing(unborn);
  });

  it('has no worktree to make when the folder is inside a repository, below its top folder', async () => {
    const inside = path.join(repo, 'packages', 'app');
    mkdirSync(inside, { recursive: true });

    // A worktree is a checkout of the whole repository: the same relative path would land elsewhere.
    await expect(
      isolation(inside).create({ rootId: 'r-1', runId: 'run-7', signal, threadId: 'thread-7' })
    ).resolves.toEqual({ noWorktree: 'inside-a-repository' });
    await madeNothing(repo);
  });
});
