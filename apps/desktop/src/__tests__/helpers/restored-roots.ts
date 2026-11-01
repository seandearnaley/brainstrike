import type { CanonicalWorkspaceLease } from '@brainstrike/canonical-ingestion';
import type { IndexSourceRoots } from '../../ipc-domains/index-source-roots';

/**
 * A roots stub as the native index borrows from it: one sync-and-borrow step over the stub's
 * own `restoreRoots` (its granted folders are the live ones) and `borrowSourceRoot`, each read
 * when the step runs.
 */
export function restoredRoots<
  R extends {
    borrowSourceRoot?: IndexSourceRoots['borrowSourceRoot'];
    restoreRoots: () => Promise<
      readonly { readonly permissionState: string; readonly rootId: string }[]
    >;
  },
>(roots: R): R & Pick<IndexSourceRoots, 'borrowLiveRoots'> {
  const borrowLiveRoots: IndexSourceRoots['borrowLiveRoots'] = async (work) => {
    const live = (await roots.restoreRoots())
      .filter((root) => root.permissionState === 'granted')
      .map((root) => root.rootId);
    return work(live, async (rootId, subscribe): Promise<CanonicalWorkspaceLease> => {
      if (!roots.borrowSourceRoot) {
        throw new Error('This roots stub mounts no folder.');
      }
      return roots.borrowSourceRoot(rootId, subscribe);
    });
  };
  return Object.assign(roots, { borrowLiveRoots });
}
