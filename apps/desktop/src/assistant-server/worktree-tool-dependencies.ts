import { gitRefused } from './git-failure';
import {
  createShellCorrelation,
  type ShellWorktreeCorrelation,
} from './shell-worktree-correlation';
import type { WorktreeService } from './worktree-service';
import type { WorktreeToolCapability } from './worktree-tools';

/** Main's lazily constructed worktree services for host threads. */
export interface DesktopWorktreeServices {
  /** Opens a worktree an agent created as a workspace folder (ADR-0028 step 3). */
  readonly openWorktreeFolder?:
    | ((path: string) => Promise<{ displayName: string; path: string; rootId: string }>)
    | undefined;
  readonly resolveWorktreeService?: (() => WorktreeService | null) | undefined;
}

/**
 * `createdBy: 'agent'` and the run/thread ids are bound HERE, never taken from
 * tool input: provenance the model can set is provenance the model can forge.
 */
export function desktopWorktreeToolDependencies(
  services: DesktopWorktreeServices,
  run: { readonly runId: string | undefined; readonly threadId: string | undefined }
): { shellCorrelation?: ShellWorktreeCorrelation; worktreeTools?: WorktreeToolCapability } {
  const service = services.resolveWorktreeService?.() ?? null;
  const { runId, threadId } = run;
  const worktreeTools: WorktreeToolCapability | undefined = service
    ? {
        archive: (params) => service.archive({ ...params, ...(runId ? { runId } : {}) }),
        // The thread moves into the worktree it created, so Main opens it as a
        // folder first: a binding names only a mounted, recorded root.
        create: async (params) => {
          const open = services.openWorktreeFolder;
          if (!open) {
            return gitRefused(
              'configuration',
              'worktree.open-unavailable',
              'Worktrees cannot be opened as folders in this session.'
            );
          }
          const created = await service.create({
            ...params,
            branch: { name: params.branch },
            createdBy: 'agent',
            ...(runId ? { runId } : {}),
            ...(threadId ? { threadId } : {}),
          });
          if (!created.ok) {
            return created;
          }
          const root = await open(created.value.worktree.path);
          return { ok: true, value: { ...created.value, root } };
        },
        list: () => service.list(),
      }
    : undefined;
  const shellCorrelation: ShellWorktreeCorrelation | undefined = service
    ? createShellCorrelation({
        reconcile: async (rootId, precedingWorktreePaths) => {
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
