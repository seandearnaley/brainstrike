import { createLogger } from '@brainstrike/logging';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { markRootsDisconnectedExcept } from './workspace-root-catalog.ts';

// Shared with the registry so its own warnings stay under one scope.
const logger = createLogger('WorkspaceRootRegistry');

/** The per-root resources a workspace root's removal or disconnection ends. */
export interface WorkspaceRootResourceOwners {
  readonly disposeCommandSessionsForRoot: (rootId: string) => Promise<number>;
  readonly evictLspServersForRoot: (rootId: string) => Promise<void>;
}

/**
 * Ends each root's LSP servers and command sessions. Strict (root data deletion) fails with
 * every cleanup failure; otherwise each failure is logged and the others still run.
 */
export async function cleanupWorkspaceRootResources(
  owners: WorkspaceRootResourceOwners,
  rootIds: readonly string[]
): Promise<void> {
  await Promise.all(
    rootIds.map(async (rootId) => {
      await Promise.all([
        owners.evictLspServersForRoot(rootId).catch((error: unknown) => {
          logger.warn('Workspace root LSP cleanup failed', { error, rootId });
        }),
        owners.disposeCommandSessionsForRoot(rootId).catch((error: unknown) => {
          logger.warn('Workspace root command-session cleanup failed', { error, rootId });
        }),
      ]);
    })
  );
}

interface WorkspaceRootCatalogConvergence {
  readonly cleanup: (rootIds: readonly string[]) => Promise<void>;
  readonly closeRootIds: readonly string[];
  readonly getRootsCatalog: () => Promise<WorkspaceRootPort>;
  readonly isExpectedCatalogRefusal: ((error: unknown) => boolean) | undefined;
  readonly mountedPaths: readonly string[];
}

/**
 * Marks every catalog root outside the mounted set disconnected (closing `closeRootIds` in the
 * same commit) and ends its resources. A refusal its owner expects is logged at info.
 */
export async function convergeWorkspaceRootCatalog({
  cleanup,
  closeRootIds,
  getRootsCatalog,
  isExpectedCatalogRefusal,
  mountedPaths,
}: WorkspaceRootCatalogConvergence): Promise<void> {
  try {
    const disconnected = await markRootsDisconnectedExcept(
      await getRootsCatalog(),
      mountedPaths,
      closeRootIds
    );
    await cleanup(disconnected.map((row) => row.id));
  } catch (error) {
    if (isExpectedCatalogRefusal?.(error)) {
      logger.info('Workspace root database convergence stopped', { error });
      return;
    }
    logger.error('Workspace root database convergence failed', { error });
  }
}
