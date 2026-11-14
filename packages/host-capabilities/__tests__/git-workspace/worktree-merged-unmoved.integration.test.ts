// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2518), over real git and a real state store:
 * archive on merge takes only a worktree whose branch moved since it was made.
 * A worktree made at a commit the default branch later took, or had already
 * taken, other than along its first-parent history (a feature branch merged
 * by a merge commit or squashed, or the tip a pull merged in as a second
 * parent) adds nothing to it; never committed to, it is still the idle cap's.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  MADE_BY_THREAD_2,
  mergedArchiveHarness,
} from './worktree-merged-archive.shared.ts';
import { git } from './worktree-service.shared.ts';

const FRESH = { runId: 'run-1', threadId: 'thread-1' } as const;

describe('archive on merge keeps a worktree never committed to (real git + real SQLite)', () => {
  const {
    commit,
    expectArchived,
    expectKept,
    featureBranch,
    fetchMain,
    host,
    mergedNotice,
    state,
  } = mergedArchiveHarness();

  it('keeps a worktree made at a feature branch that main then took by a merge commit', async () => {
    const { make } = host();
    featureBranch();
    const unused = await make('at-feature', MADE_BY_THREAD_2, 'feat');
    git(state.repo, [...IDENTITY, 'merge', '--no-ff', '-m', 'Merge feat', 'feat']);
    fetchMain();

    await make('fresh', FRESH);

    await expectKept(unused);
    expect(state.told).toEqual([]);
  });

  it('keeps a worktree made at a feature branch that main then took by a squash', async () => {
    const { make } = host();
    featureBranch();
    const unused = await make('at-squashed', MADE_BY_THREAD_2, 'feat');
    git(state.repo, ['merge', '--squash', 'feat']);
    git(state.repo, [...IDENTITY, 'commit', '-m', 'feat (#1)']);
    fetchMain();

    await make('fresh', FRESH);

    await expectKept(unused);
    expect(state.told).toEqual([]);
  });

  it("keeps a worktree made at origin's tip, which a pull then merged in as a second parent", async () => {
    // Someone else's commit is origin's tip; the person's main has a commit of its own.
    git(state.repo, ['checkout', '--quiet', '-b', 'upstream']);
    commit(state.repo, 'theirs.ts', 'export const theirs = 1;\n', 'their work');
    git(state.repo, ['update-ref', 'refs/remotes/origin/main', 'refs/heads/upstream']);
    git(state.repo, ['checkout', '--quiet', 'main']);
    commit(state.repo, 'mine.ts', 'export const mine = 1;\n', 'my work');
    const { make } = host();
    const unused = await make('at-origin', MADE_BY_THREAD_2, 'origin/main');
    // The person pulls with a merge, so origin's old tip is the merge's second parent, and pushes.
    git(state.repo, [...IDENTITY, 'merge', '--no-ff', '-m', 'Merge origin', 'origin/main']);
    fetchMain();

    await make('fresh', FRESH);

    await expectKept(unused);
    expect(state.told).toEqual([]);
  });

  // Only the worktree just made is left out of its own pass, so the one made a moment before,
  // which no thread is bound to yet, is in it.
  it('keeps a worktree made moments before another, at a commit main had already taken', async () => {
    featureBranch();
    git(state.repo, [...IDENTITY, 'merge', '--no-ff', '-m', 'Merge feat', 'feat']);
    fetchMain();
    const { make } = host();
    const first = await make('first', MADE_BY_THREAD_2, 'feat');

    await make('second', FRESH);

    await expectKept(first);
    expect(state.told).toEqual([]);
  });

  it('archives a worktree made at a feature branch once its own commits merge', async () => {
    const { make } = host();
    featureBranch();
    const worked = await make('worked', MADE_BY_THREAD_2, 'feat');
    commit(worked.path, 'worked.ts', 'export const worked = 1;\n', 'its own work');
    git(state.repo, [...IDENTITY, 'merge', '--no-ff', '-m', 'Merge worked', 'bs/worked']);
    fetchMain();
    state.told = [];

    await make('fresh', FRESH);

    await expectArchived(worked);
    expect(state.told).toEqual([mergedNotice(worked)]);
  });
});
