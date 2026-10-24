import type { WorkspaceRootRegistry } from '../../ipc-domains/workspace-root-registry';

/**
 * A registry stub as the open borrows from it: one restore-and-borrow step over the stub's own
 * `restoreRoots` and `borrowSourceRoot`, each read when the step runs.
 */
export function restoredRoots<
  R extends {
    borrowSourceRoot?: WorkspaceRootRegistry['borrowSourceRoot'];
    restoreRoots: () => Promise<unknown>;
  },
>(roots: R): R & Pick<WorkspaceRootRegistry, 'borrowRestoredRoots'> {
  const borrowRestoredRoots: WorkspaceRootRegistry['borrowRestoredRoots'] = async (work) =>
    work((await roots.restoreRoots()) as Parameters<typeof work>[0], (rootId, subscribe) => {
      if (!roots.borrowSourceRoot) {
        throw new Error('This registry stub mounts no folder.');
      }
      return roots.borrowSourceRoot(rootId, subscribe);
    });
  return Object.assign(roots, { borrowRestoredRoots });
}
