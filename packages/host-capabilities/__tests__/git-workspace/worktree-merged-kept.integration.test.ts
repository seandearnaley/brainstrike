// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2504), over real git and a real state store:
 * the worktrees archive on merge keeps. A worktree a thread is bound to, one
 * whose branch adds to main or has no commits of its own (made and never
 * committed to, or only moved along main), one with uncommitted changes, a
 * locked or detached one, the one just made and one that takes a commit while
 * its archive waits all stay, as does one whose history is unrelated to main's
 * (BST-2518); and in a repository where the check cannot run (an old git, no
 * default branch, a merge driver of its own, also one named after the pass
 * began, or a partial clone), nothing is archived. The worktrees it archives
 * are in `worktree-merged-archive.integration.test.ts`; one never committed to
 * is kept whatever main took (`worktree-merged-unmoved.integration.test.ts`).
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ManagedWorktreeRow } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import {
  IDENTITY,
  type ListedThread,
  mergedArchiveHarness,
} from './worktree-merged-archive.shared.ts';
import { git } from './worktree-service.shared.ts';

const { loggerError, loggerInfo } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({ debug: vi.fn(), error: loggerError, info: loggerInfo, warn: vi.fn() }),
  };
});

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

  // A branch only moved along main has no commits of its own, though its tip has moved.
  it('keeps a worktree fast-forwarded to main', async () => {
    const { make } = host();
    const moved = await make('fast-forwarded');
    commit(state.repo, 'later.ts', 'export const later = true;\n', 'later work on main');
    fetchMain();
    git(moved.path, ['merge', '--quiet', '--ff-only', 'refs/remotes/origin/main']);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(moved);
    expect(state.told).toEqual([]);
  });

  it('keeps a worktree rebased onto main, which already took its one commit', async () => {
    const { make } = host();
    const rebased = await make('rebased');
    commit(rebased.path, 'rebased.ts', 'export const rebased = 1;\n', 'its own work');
    git(state.repo, [...IDENTITY, 'cherry-pick', 'bs/rebased']);
    commit(state.repo, 'later.ts', 'export const later = true;\n', 'later work on main');
    fetchMain();
    // The rebase drops the commit main already has, so the branch is main's tip.
    git(rebased.path, [...IDENTITY, 'rebase', '--quiet', 'refs/remotes/origin/main']);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(rebased);
    expect(state.told).toEqual([]);
  });

  it('keeps a worktree reset to an older commit of main', async () => {
    commit(state.repo, 'second.ts', 'export const second = 1;\n', 'second commit on main');
    const { make } = host();
    const reset = await make('reset');
    fetchMain();
    git(reset.path, ['reset', '--quiet', '--hard', 'HEAD~1']);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(reset);
    expect(state.told).toEqual([]);
  });

  // The pass checks each worktree before it asks for the archive, and the archive's turn checks
  // again, so a commit made in between keeps the worktree.
  it('keeps a merged worktree that takes a commit while its archive waits', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'busy');
    state.beforeArchive = (worktreeId) => {
      if (worktreeId === merged.id) {
        commit(merged.path, 'more.ts', 'export const more = 1;\n', 'work while the archive waits');
      }
    };

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(state.told).toEqual([]);
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

  // The ticket asks that the reason be logged; the log is the only place it shows.
  it('archives nothing in a repository with no default branch, and logs why', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'no-origin');
    git(state.repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    loggerInfo.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(state.told).toEqual([]);
    expect(loggerInfo).toHaveBeenCalledWith(
      'Archive on merge does not run in this repository',
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'changeset.base-ref-unresolved' }),
      })
    );
  });

  it('archives nothing on a git older than 2.38', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'old-git');
    state.run = async (params) =>
      params.args.includes('--version')
        ? { exitCode: 0, stderr: '', stdout: 'git version 2.37.1\n', timedOut: false }
        : await execFileGitRunner(params);

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(state.told).toEqual([]);
  });

  /** A file both main and the squash-merged branch changed, so telling the merge needs a content merge. */
  async function mergedByContent(make: (name: string) => Promise<ManagedWorktreeRow>) {
    const lines = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n7\n8\n9\n${last}\n`;
    commit(state.repo, 'shared.ts', lines('1', '10'), 'shared file');
    const merged = await make('driver');
    commit(merged.path, 'shared.ts', lines('one', '10'), 'edit its first line');
    git(state.repo, ['merge', '--squash', 'bs/driver']);
    git(state.repo, [...IDENTITY, 'commit', '-m', 'driver (#1)']);
    commit(state.repo, 'shared.ts', lines('one', 'ten'), 'edit its last line');
    fetchMain();
    return merged;
  }

  /** Names a merge driver in the repository's own config; it leaves a marker when it runs. */
  function configureDriver(): string {
    const marker = path.join(tempDir('bst-merge-driver-'), 'ran');
    git(state.repo, ['config', 'merge.mine.driver', `touch ${marker}`]);
    writeFileSync(path.join(state.repo, '.git', 'info', 'attributes'), '* merge=mine\n');
    return marker;
  }

  // BST-2454's boundary: the host never runs a command the repository's own config names.
  // Telling this merge needs a content merge of `shared.ts`, which would run the driver.
  it("never runs a merge driver the repository's own config names", async () => {
    const { make } = host();
    const merged = await mergedByContent(make);
    const marker = configureDriver();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(merged);
    expect(existsSync(marker)).toBe(false);
    expect(state.told).toEqual([]);
  });

  // The archive's own turn asks again whether the check can run, not only whether it merged.
  it('never runs a merge driver the repository names after the pass began', async () => {
    const { make } = host();
    const merged = await mergedByContent(make);
    let marker: string | undefined;
    state.beforeArchive = (worktreeId) => {
      if (worktreeId === merged.id) {
        marker = configureDriver();
      }
    };

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    expect(marker).toBeDefined();
    expect(existsSync(marker ?? '')).toBe(false);
    await expectKept(merged);
    expect(state.told).toEqual([]);
  });

  // A branch whose history shares no commit with main's first-parent history, merged into main as
  // a second parent, is not on that history; it is not merged, and that is no failure to log.
  it('keeps a worktree whose branch has history unrelated to main, merged in as a second parent', async () => {
    const { make } = host();
    const unrelated = await make('unrelated');
    const blob = git(state.repo, ['hash-object', '-w', '--stdin'], 'export const other = 1;\n');
    const tree = git(state.repo, ['mktree'], `100644 blob ${blob.trim()}\tother.ts\n`).trim();
    const root = git(state.repo, [...IDENTITY, 'commit-tree', tree, '-m', 'another root']).trim();
    git(unrelated.path, ['reset', '--quiet', '--hard', root]);
    git(state.repo, [
      ...IDENTITY,
      'merge',
      '--allow-unrelated-histories',
      '--no-ff',
      '-m',
      'Merge another history',
      'bs/unrelated',
    ]);
    fetchMain();
    loggerError.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectKept(unrelated);
    expect(state.told).toEqual([]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  // In a partial clone a blob the merge needs may be missing, and git would fetch it on demand;
  // the host never fetches.
  it('archives nothing in a partial clone, and fetches nothing', async () => {
    const lines = (first: string, last: string) => `${first}\n2\n3\n4\n5\n6\n7\n8\n9\n${last}\n`;
    const source = state.repo;
    commit(source, 'shared.ts', lines('1', '10'), 'shared file');
    const older = git(source, ['rev-parse', 'HEAD']).trim();
    const olderBlob = git(source, ['rev-parse', 'HEAD:shared.ts']).trim();
    commit(source, 'shared.ts', lines('1', 'ten'), 'edit its last line');
    // The clone's source serves it filtered: a blob it leaves out is fetched on demand.
    git(source, ['config', 'uploadpack.allowFilter', 'true']);
    const clone = path.join(tempDir('bst-partial-clone-'), 'clone');
    git(tempDir('bst-partial-cwd-'), [
      'clone',
      '--quiet',
      '--filter=blob:none',
      `file://${source}`,
      clone,
    ]);
    const missing = () =>
      git(clone, ['rev-list', '--objects', '--all', '--missing=print'])
        .split('\n')
        .includes(`?${olderBlob}`);
    expect(missing()).toBe(true);
    state.repo = clone;
    const { make } = host();
    const partial = await make('partial');
    // Its own commit, on the older commit: telling the merge needs the older blob, which the clone
    // lacks. Made without reading any blob, so nothing here fetches it.
    writeFileSync(path.join(partial.path, 'shared.ts'), lines('one', 'ten'));
    git(partial.path, ['add', '--', 'shared.ts']);
    const tree = git(partial.path, ['write-tree']).trim();
    const own = git(partial.path, [...IDENTITY, 'commit-tree', tree, '-p', older, '-m', 'its own']);
    git(partial.path, ['reset', '--quiet', '--soft', own.trim()]);
    loggerInfo.mockClear();

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    expect(missing()).toBe(true);
    await expectKept(partial);
    expect(loggerInfo).toHaveBeenCalledWith(
      'Archive on merge does not run in this repository',
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'worktree.partial-clone' }),
      })
    );
  });
});
