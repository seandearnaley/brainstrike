import { gitRefused } from './git-failure.ts';
import {
  createShellCorrelation,
  type ShellWorktreeCorrelation,
} from './shell-worktree-correlation.ts';
import type { WorktreeService } from './worktree-service.ts';
import type { WorktreeToolCapability } from './worktree-tools.ts';

/** The host's worktree services, which each run borrows under its own identity. */
export interface HostWorktreeServices {
  /** Opens a worktree an agent created as a workspace folder (ADR-0028 step 3); desktop only. */
  readonly openWorktreeFolder?:
    | ((path: string) => Promise<{ displayName: string; path: string; rootId: string }>)
    | undefined;
  readonly resolveWorktreeService?: (() => WorktreeService | null) | undefined;
}

/**
 * `createdBy: 'agent'` and the run/thread ids are bound HERE, never taken from
 * tool input: provenance the model can set is provenance the model can forge.
 */
export function hostWorktreeToolDependencies(
  services: HostWorktreeServices,
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
