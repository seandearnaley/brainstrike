import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { type ReactNode, useEffect } from 'react';
import { RootIdentityProvider } from './root-identity-context';
import { useRootsReconciliation } from './use-roots-reconciliation';

const logger = createLogger('WorkspaceRootIdentity');

/**
 * Keeps the host-recorded root of every mounted folder mapped, and provides that mapping to the
 * layout. The mounted set is synced as a whole: a removed folder is forgotten, so re-adding it
 * under its one id registers it again (BST-1990).
 */
export function WorkspaceRootIdentity({ children }: { readonly children: ReactNode }) {
  const { fileSystemAdapter } = useAdapters();
  const { mountedRootHandles } = useFileSystem();
  const { dbRootIdByAdapterRootId, syncMountedRoots } = useRootsReconciliation({
    adapter: fileSystemAdapter,
  });
  useEffect(() => {
    let disposed = false;
    void fileSystemAdapter
      .restoreRoots?.()
      .then((roots) => (disposed ? undefined : syncMountedRoots(roots)))
      .catch((error: unknown) => {
        logger.error('Mounted folders could not be restored for root mapping', { error });
      });
    return () => {
      disposed = true;
    };
  }, [fileSystemAdapter, syncMountedRoots, mountedRootHandles]);
  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
      {children}
    </RootIdentityProvider>
  );
}
