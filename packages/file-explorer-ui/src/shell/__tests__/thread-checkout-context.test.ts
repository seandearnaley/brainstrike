import type { DirectoryHandle } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { threadCheckoutView } from '../thread-checkout-context';

function folder(rootId: string, worktree?: true): DirectoryHandle {
  return {
    kind: 'directory',
    name: rootId,
    path: `/disposable/${rootId}`,
    platform: 'electron',
    rootId,
    ...(worktree ? { worktree } : {}),
  };
}

const repo = folder('repo');
const notes = folder('notes');
const linked = folder('linked', true);
const other = folder('other', true);

describe('threadCheckoutView (ADR-0034)', () => {
  it('lists each open folder once and no worktree when the thread works locally', () => {
    expect(threadCheckoutView([repo, linked, notes, other], repo, null)).toEqual({
      focused: repo,
      handles: [repo, notes],
    });
  });

  it("shows the thread's worktree in place of the folder it was made from", () => {
    const checkout = { localRootId: 'repo', worktreeRootId: 'linked' };
    expect(threadCheckoutView([repo, notes, linked, other], repo, checkout)).toEqual({
      focused: linked,
      handles: [linked, notes],
    });
  });

  it('keeps focus on a folder that stays visible', () => {
    const checkout = { localRootId: 'repo', worktreeRootId: 'linked' };
    expect(threadCheckoutView([repo, notes, linked], notes, checkout).focused).toBe(notes);
  });

  it('appends a worktree whose folder is not open', () => {
    const checkout = { localRootId: null, worktreeRootId: 'linked' };
    expect(threadCheckoutView([notes, linked], other, checkout)).toEqual({
      focused: linked,
      handles: [notes, linked],
    });
  });

  it('leaves the folder in place while the worktree is not mounted yet', () => {
    const checkout = { localRootId: 'repo', worktreeRootId: 'linked' };
    expect(threadCheckoutView([repo], repo, checkout)).toEqual({ focused: repo, handles: [repo] });
  });
});
