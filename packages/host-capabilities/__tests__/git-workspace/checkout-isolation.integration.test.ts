// @vitest-environment node

/**
 * ADR-0034 Automatic isolation, the platform's part, over real git and a real
 * state store: the worktree a host makes for a thread starts from the
 * checkout's last commit and is recorded as the agent's, and a checkout's
 * uncommitted paths are the ones git reports.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostCheckoutIsolation } from '../../src/git-workspace/checkout-isolation.ts';
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

  it('refuses with the reason when the folder is not a repository', async () => {
    const folder = workspace.freshTempDir('bst-isolation-plain-');
    const refusal = await isolation(folder)
      .create({ rootId: 'r-1', runId: 'run-7', signal, threadId: 'thread-7' })
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(BoundaryFailureError);
    expect((refusal as BoundaryFailureError).failure.kind).toBe('refusal');
    expect((refusal as BoundaryFailureError).message).toContain('not a git repository');
    expect(opened).toEqual([]);
  });
});
