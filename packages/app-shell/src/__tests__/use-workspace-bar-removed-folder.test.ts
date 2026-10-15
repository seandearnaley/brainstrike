/**
 * BST-1990: a thread folder the workspace no longer serves. The host refuses
 * every write and run while the binding names one, so each repair action drops
 * every removed folder in the same patch, and a removed primary hands over to a
 * live folder instead of being demoted into the secondaries.
 */
import { describe, expect, it } from 'vitest';
import type { ThreadCheckoutFolders, ThreadCheckoutRoot } from '../hooks/use-thread-folders-write';
import {
  deriveMakePrimary,
  deriveRemoveFromThread,
  deriveUseFolder,
} from '../hooks/use-workspace-bar-write-derive';

const alpha = { displayName: 'alpha', path: '/ws/alpha', rootId: 'r-alpha' } as const;
const bravo: ThreadCheckoutRoot = {
  displayName: 'bravo',
  path: '/ws/bravo',
  removed: true,
  rootId: 'r-bravo',
};
const charlie: ThreadCheckoutRoot = {
  displayName: 'charlie',
  path: '/ws/charlie',
  removed: true,
  rootId: 'r-charlie',
};
const delta: ThreadCheckoutRoot = { displayName: 'delta', path: '/ws/delta', rootId: 'r-delta' };

function folders(
  primaryRoot: ThreadCheckoutRoot | undefined,
  secondaryRoots: readonly ThreadCheckoutRoot[],
  checkout: Pick<ThreadCheckoutFolders, 'checkoutLocalRootId' | 'checkoutMode'> = {
    checkoutLocalRootId: undefined,
    checkoutMode: 'local',
  }
): ThreadCheckoutFolders {
  return {
    ...checkout,
    metadataPending: false,
    primaryRoot,
    primaryRootId: primaryRoot?.rootId,
    secondaryRootIds: secondaryRoots.map((root) => root.rootId),
    secondaryRoots,
    secondaryRootsError: false,
    secondaryRootsPending: false,
    threadId: 'thread-1',
  };
}

describe('a removed thread folder', () => {
  it('is dropped, not demoted, when another folder is made primary (the stuck-primary repro)', () => {
    const write = deriveMakePrimary(folders(bravo, [alpha]), 'r-alpha');
    expect(write.binding).toEqual({
      operatingRootDisplayName: 'alpha',
      operatingRootId: 'r-alpha',
      operatingRootPath: '/ws/alpha',
    });
    expect(write.ids).toEqual([]);
    expect(write.secondaryRoots).toEqual([]);
  });

  it('is dropped from the secondaries in the same Make primary write', () => {
    const write = deriveMakePrimary(folders(alpha, [bravo, delta]), 'r-delta');
    expect(write.binding?.['operatingRootId']).toBe('r-delta');
    expect(write.ids).toEqual(['r-alpha']);
  });

  it('cannot itself be made primary', () => {
    expect(() => deriveMakePrimary(folders(alpha, [bravo]), 'r-bravo')).toThrow(
      'bravo was removed from the workspace. Re-add it before making it primary.'
    );
  });

  it('as the primary, is removed by promoting the first live folder and dropping every removed one', () => {
    const write = deriveRemoveFromThread(folders(bravo, [charlie, alpha, delta]), 'r-bravo');
    expect(write.binding).toEqual({
      operatingRootDisplayName: 'alpha',
      operatingRootId: 'r-alpha',
      operatingRootPath: '/ws/alpha',
    });
    expect(write.primaryRootId).toBe('r-alpha');
    expect(write.ids).toEqual(['r-delta']);
  });

  it('as the primary, stays until the thread has another live folder', () => {
    expect(() => deriveRemoveFromThread(folders(bravo, [charlie]), 'r-bravo')).toThrow(
      'Choose another folder for this thread first.'
    );
  });

  it('never lets a live primary be removed', () => {
    expect(() => deriveRemoveFromThread(folders(alpha, [delta]), 'r-alpha')).toThrow(
      'The primary folder stays; make another folder primary first.'
    );
  });

  it('goes with any other removal, since the host refuses a binding that keeps it', () => {
    const write = deriveRemoveFromThread(folders(alpha, [bravo, delta]), 'r-delta');
    expect(write.binding).toBeUndefined();
    expect(write.ids).toEqual([]);
  });

  it('as the hand-off return folder, takes the thread back to Local when removed', () => {
    const worktree: ThreadCheckoutRoot = {
      displayName: 'bright-fox',
      path: '/managed/bright-fox',
      rootId: 'r-worktree',
    };
    const write = deriveRemoveFromThread(
      folders(worktree, [bravo], { checkoutLocalRootId: 'r-bravo', checkoutMode: 'worktree' }),
      'r-bravo'
    );
    expect(write.binding).toEqual({ checkoutMode: 'local' });
    expect(write.checkoutLocalRootId).toBeUndefined();
    expect(write.ids).toEqual([]);
  });

  it('leaves a thread with no live folder free to use another workspace folder', () => {
    const write = deriveUseFolder(folders(bravo, [charlie]), alpha);
    expect(write.binding).toEqual({
      operatingRootDisplayName: 'alpha',
      operatingRootId: 'r-alpha',
      operatingRootPath: '/ws/alpha',
    });
    expect(write.ids).toEqual([]);
    expect(write.secondaryRoots).toEqual([]);
  });

  it('is replaced by another workspace folder only while the thread has no live folder', () => {
    expect(() => deriveUseFolder(folders(bravo, [delta]), alpha)).toThrow(
      'This thread still has a live folder; make it primary instead.'
    );
  });
});
