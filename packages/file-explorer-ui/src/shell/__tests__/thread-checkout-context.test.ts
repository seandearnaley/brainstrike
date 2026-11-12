import type { DirectoryHandle } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { threadCheckoutView } from '../thread-checkout-context';

function folder(rootId: string, worktree?: true, scratch?: true): DirectoryHandle {
  return {
    kind: 'directory',
    name: rootId,
    path: `/disposable/${rootId}`,
    platform: 'electron',
    rootId,
    ...(worktree ? { worktree } : {}),
    ...(scratch ? { scratch } : {}),
  };
}

const repo = folder('repo');
const notes = folder('notes');
const linked = folder('linked', true);
const other = folder('other', true);
// Scratch folders (ADR-0034): the folders the host made for two threads sent with no folder.
const ownScratch = folder('own-scratch', undefined, true);
const otherScratch = folder('other-scratch', undefined, true);

describe('threadCheckoutView (ADR-0034)', () => {
  it('lists each open folder once and no worktree when the thread works locally', () => {
    expect(threadCheckoutView([repo, linked, notes, other], repo, null)).toEqual({
      focused: repo,
      handles: [repo, notes],
    });
  });

  it("shows the thread's worktree in place of the folder it was made from", () => {
    const checkout = { localRootId: 'repo', threadRootId: 'linked' };
    expect(threadCheckoutView([repo, notes, linked, other], repo, checkout)).toEqual({
      focused: linked,
      handles: [linked, notes],
    });
  });

  it('keeps focus on a folder that stays visible', () => {
    const checkout = { localRootId: 'repo', threadRootId: 'linked' };
    expect(threadCheckoutView([repo, notes, linked], notes, checkout).focused).toBe(notes);
  });

  it('appends a worktree whose folder is not open', () => {
    const checkout = { localRootId: null, threadRootId: 'linked' };
    expect(threadCheckoutView([notes, linked], other, checkout)).toEqual({
      focused: linked,
      handles: [notes, linked],
    });
  });

  it("shows only the active thread's scratch folder, never another thread's", () => {
    expect(threadCheckoutView([ownScratch, otherScratch], null, null)).toEqual({
      focused: null,
      handles: [],
    });
    const checkout = { localRootId: null, threadRootId: 'own-scratch' };
    expect(threadCheckoutView([otherScratch, ownScratch], otherScratch, checkout)).toEqual({
      focused: ownScratch,
      handles: [ownScratch],
    });
    // Beside a folder opened since, the scratch folder stays the thread's.
    expect(threadCheckoutView([repo, ownScratch, otherScratch], repo, checkout)).toEqual({
      focused: repo,
      handles: [repo, ownScratch],
    });
  });

  it('leaves the folder in place while the worktree is not mounted yet', () => {
    const checkout = { localRootId: 'repo', threadRootId: 'linked' };
    expect(threadCheckoutView([repo], repo, checkout)).toEqual({ focused: repo, handles: [repo] });
  });
});
