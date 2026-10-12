import { desktopAssistantServerLogger as logger } from './logger';
import type { AssistantServerOptions } from './server-options';
import {
  createShellCorrelation,
  type ShellWorktreeCorrelation,
} from './shell-worktree-correlation';
import type { WorktreeToolCapability } from './worktree-tools';

/** Main's lazily constructed worktree and forge services for host threads. */
export type DesktopWorktreeServices = Pick<
  AssistantServerOptions,
  'resolveForgeService' | 'resolveWorktreeService'
>;

/**
 * `createdBy: 'agent'` and the run/thread ids are bound HERE, never taken from
 * tool input: provenance the model can set is provenance the model can forge.
 */
export function desktopWorktreeToolDependencies(
  services: DesktopWorktreeServices,
  run: { readonly runId: string | undefined; readonly threadId: string | undefined }
): { shellCorrelation?: ShellWorktreeCorrelation; worktreeTools?: WorktreeToolCapability } {
  const service = services.resolveWorktreeService?.() ?? null;
  const forge = services.resolveForgeService?.() ?? null;
  const { runId, threadId } = run;
  const worktreeTools: WorktreeToolCapability | undefined = service
    ? {
        archive: (params) => service.archive({ ...params, ...(runId ? { runId } : {}) }),
        create: (params) =>
          service.create({
            ...params,
            branch: { name: params.branch },
            createdBy: 'agent',
            ...(runId ? { runId } : {}),
            ...(threadId ? { threadId } : {}),
          }),
        list: () => service.list(),
      }
    : undefined;
  const shellCorrelation: ShellWorktreeCorrelation | undefined =
    service || forge
      ? createShellCorrelation({
          forgeRefresh: (rootId) => {
            // `refresh` returns a Promise; `void`-ing the call alone let its
            // rejection go unhandled. `.catch` per the same shape
            // `onRepositoryInvalidated` already uses (forge-service.ts:626).
            forge?.refresh(rootId, 'shell').catch((error: unknown) => {
              logger.error('shell forge refresh threw', { error, rootId });
            });
          },
          reconcile: async (rootId, precedingWorktreePaths) => {
            if (!service) {
              return { error: 'Worktrees are unavailable in this session.', ok: false };
            }
            const context = await service.repositoryContextForRoot(rootId);
            if (!context.ok) {
              return context;
            }
            return await service.reconcileFromShell({
              precedingWorktreePaths,
              repoCommonDir: context.value.commonDir,
              ...(runId ? { runId } : {}),
              ...(threadId ? { threadId } : {}),
            });
          },
        })
      : undefined;
  return {
    ...(shellCorrelation ? { shellCorrelation } : {}),
    ...(worktreeTools ? { worktreeTools } : {}),
  };
}
