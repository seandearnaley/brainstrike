import { expect, it, vi } from 'vitest';
import { createRegistry, createStorage } from './workspace-root-registry-test-helpers';

const ROOTS_LIST = 'rootsList';

function storedRoots(...roots: readonly { path: string; rootId: string }[]): string {
  return JSON.stringify(roots.map((root, index) => ({ addedAt: index + 1, ...root })));
}

it('tells the index when a restore mounts folders other than the ones it borrowed', async () => {
  const storage = createStorage();
  const onRestoredRootsChanged = vi.fn();
  const registry = createRegistry({ onRestoredRootsChanged, storage });

  // A restore before the index's first open needs no word: that open borrows what it finds.
  await registry.restoreRoots();
  expect(onRestoredRootsChanged).not.toHaveBeenCalled();

  // The index opens with no folders.
  await registry.borrowRestoredRoots(async () => undefined);

  // The folder list changes behind Main's back, then a window reload restores it.
  await storage.setItem(ROOTS_LIST, storedRoots({ path: '/work/notes', rootId: 'notes' }));
  await registry.restoreRoots();
  expect(onRestoredRootsChanged).toHaveBeenCalledOnce();

  // The index re-reads and borrows the folder; restoring the same folders again says nothing.
  await registry.borrowRestoredRoots(async () => undefined);
  await registry.restoreRoots();
  expect(onRestoredRootsChanged).toHaveBeenCalledOnce();

  // A folder that is gone at the next restore changes the set too.
  await storage.setItem(ROOTS_LIST, storedRoots());
  await registry.restoreRoots();
  expect(onRestoredRootsChanged).toHaveBeenCalledTimes(2);
  await registry.dispose();
});
