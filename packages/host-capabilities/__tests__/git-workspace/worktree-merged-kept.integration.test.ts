// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2504), over real git and a real state store:
 * the worktrees archive on merge keeps. A worktree a thread is bound to, one
 * whose branch adds to main or has no commits of its own, one with uncommitted
 * changes, a locked or detached one and the one just made all stay; and in a
 * repository where the check cannot run, nothing is archived and the reason is
 * logged. The worktrees it archives are in
 * `worktree-merged-archive.integration.test.ts`.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import {
  IDENTITY,
  type ListedThread,
  mergedArchiveHarness,
} from './worktree-merged-archive.shared.ts';
import { git } from './worktree-service.shared.ts';

const { loggerInfo } = vi.hoisted(() => ({ loggerInfo: vi.fn() }));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: loggerInfo, warn: vi.fn() }),
  };
});

/** The pass logged that it does not run in the repository, with the refusal `code`. */
function expectNotRunBecause(code: string): void {
  expect(loggerInfo).toHaveBeenCalledWith(
    'Archive on merge does not run in this repository',
    expect.objectContaining({ reason: expect.objectContaining({ code }) })
  );
}

describe('archive on merge keeps (real git + real SQLite)', () => {
  const { commit, expectKept, fetchMain, host, squashMerged, state, tempDir } =
    mergedArchiveHarness();

  it('keeps a merged worktree a thread is bound to', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'bound');
    state.threads = [
      state.threads[0] as ListedThread,
      {
        binding: {
          checkoutLocalRootId: 'r-1',
          checkoutMode: 'worktree',
          checkoutWorktreeId: merged.id,
          checkoutWorktreePath: merged.path,
        },
        hasRun: true,
        threadId: 'thread-2',
      },
    ];

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(state.told).toEqual([]);
  });

  it('keeps a worktree whose branch has a commit main lacks', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'continued');
    commit(merged.path, 'more.ts', 'export const more = 1;\n', 'more work after the merge');

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
  });

  it('keeps a merged worktree with uncommitted changes', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'dirty');
    writeFileSync(path.join(merged.path, 'draft.ts'), 'export const draft = true;\n');

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
  });

  it('keeps a locked merged worktree', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'locked');
    git(state.repo, ['worktree', 'lock', '--reason', 'on a removable drive', merged.path]);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(state.told).toEqual([]);
  });

  it('keeps a merged worktree whose HEAD is detached', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'detached');
    git(merged.path, ['checkout', '--quiet', '--detach']);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
  });

  // A worktree made and never committed to adds nothing to main either; the idle cap clears it.
  it('keeps a worktree whose branch has no commits of its own', async () => {
    const { make } = host();
    const unused = await make('unused');
    fetchMain();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(unused);
  });

  it('keeps the worktree just made, though its setup commit adds nothing to main', async () => {
    // The setup commits nothing new, so by its branch alone the worktree counts as merged.
    const { make } = host((worktree) => {
      git(worktree.path, [...IDENTITY, 'commit', '--allow-empty', '-m', 'setup']);
    });
    fetchMain();

    const fresh = await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(fresh);
    expect(state.told).toEqual([]);
  });

  it('archives nothing in a repository with no default branch, and says why', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'no-origin');
    git(state.repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    loggerInfo.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expectNotRunBecause('changeset.base-ref-unresolved');
  });

  it('archives nothing on a git older than 2.38, and says why', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'old-git');
    state.run = async (params) =>
      params.args.includes('--version')
        ? { exitCode: 0, stderr: '', stdout: 'git version 2.37.1\n', timedOut: false }
        : await execFileGitRunner(params);
    loggerInfo.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expectNotRunBecause('git.version-unsupported');
  });

  // BST-2454's boundary: the host never runs a command the repository's own config names.
  // Telling this merge needs a content merge of `shared.ts`, which would run the driver.
  it("never runs a merge driver the repository's own config names", async () => {
    const marker = path.join(tempDir('bst-merge-driver-'), 'ran');
    const lines = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n7\n8\n9\n${last}\n`;
    commit(state.repo, 'shared.ts', lines('1', '10'), 'shared file');
    const { make } = host();
    const merged = await make('driver');
    commit(merged.path, 'shared.ts', lines('one', '10'), 'edit its first line');
    git(state.repo, ['merge', '--squash', 'bs/driver']);
    git(state.repo, [...IDENTITY, 'commit', '-m', 'driver (#1)']);
    commit(state.repo, 'shared.ts', lines('one', 'ten'), 'edit its last line');
    fetchMain();
    git(state.repo, ['config', 'merge.mine.driver', `touch ${marker}`]);
    writeFileSync(path.join(state.repo, '.git', 'info', 'attributes'), '* merge=mine\n');
    loggerInfo.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(existsSync(marker)).toBe(false);
    expectNotRunBecause('worktree.repository-merge-driver');
  });
});
