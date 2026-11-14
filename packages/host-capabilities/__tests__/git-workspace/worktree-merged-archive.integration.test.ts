// @vitest-environment node

/**
 * ADR-0034 build decisions (BST-2504), over real git and a real state store: a
 * managed worktree that no thread is bound to, whose branch has commits of its
 * own and adds nothing the repository's default branch lacks, is archived the
 * way the idle cap archives (its snapshot ref and branch kept), and the thread
 * that made it is told. A squash merge counts as well as an ordinary one. The
 * worktrees it keeps are in `worktree-merged-kept.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { IDENTITY, mergedArchiveHarness } from './worktree-merged-archive.shared.ts';
import { git } from './worktree-service.shared.ts';

describe('archive on merge (real git + real SQLite)', () => {
  const { commit, expectArchived, expectKept, fetchMain, host, mergedNotice, squashMerged, state } =
    mergedArchiveHarness();

  it('archives a worktree whose branch was squash-merged, and tells the thread that made it', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'squashed');
    // Main moved on after the squash.
    commit(state.repo, 'later.ts', 'export const later = true;\n', 'later work');
    fetchMain();
    state.told = [];

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectArchived(merged);
    expect(state.told).toEqual([mergedNotice(merged)]);
  });

  it('archives a worktree whose branch was merged ordinarily', async () => {
    const { make } = host();
    const merged = await make('ordinary');
    commit(merged.path, 'ordinary.ts', 'export const ordinary = 1;\n', 'ordinary work');
    git(state.repo, [...IDENTITY, 'merge', '--no-ff', '-m', 'Merge ordinary', 'bs/ordinary']);
    fetchMain();
    state.told = [];

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectArchived(merged);
    expect(state.told).toEqual([mergedNotice(merged)]);
  });

  it('archives a merged worktree untold when the thread that made it is gone', async () => {
    const { make } = host();
    const merged = await squashMerged(make, 'orphaned');
    state.threads = state.threads.filter(({ threadId }) => threadId !== 'thread-2');
    state.told = [];

    await make('fresh', { runId: 'run-1', threadId: 'thread-1' });

    await expectArchived(merged);
    expect(state.told).toEqual([]);
  });

  it('archives a merged idle worktree once the host opens', async () => {
    const { cap, make } = host();
    const unmerged = await make('unmerged');
    commit(unmerged.path, 'unmerged.ts', 'export const unmerged = 1;\n', 'not merged');
    // Merged after the last creation's pass, so only the pass after opening can archive it.
    const merged = await squashMerged(make, 'at-start');

    await cap.afterOpen();

    await expectArchived(merged);
    await expectKept(unmerged);
    expect(state.told).toEqual([mergedNotice(merged)]);
  });

  it('stops the pass after the host opens when the host closes', async () => {
    const { cap, make } = host();
    const merged = await squashMerged(make, 'closing');

    const pass = cap.afterOpen();
    await cap.close();

    await expect(pass).resolves.toBeUndefined();
    await expectKept(merged);
  });
});
