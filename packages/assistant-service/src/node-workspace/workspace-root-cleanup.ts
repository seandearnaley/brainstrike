import { createLogger } from '@brainstrike/logging';

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
  rootIds: readonly string[],
  strict = false
): Promise<void> {
  if (strict) {
    const outcomes = await Promise.allSettled(
      rootIds.flatMap((rootId) => [
        owners.evictLspServersForRoot(rootId),
        owners.disposeCommandSessionsForRoot(rootId),
      ])
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Root data deletion resource cleanup failed.');
    }
    return;
  }
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
