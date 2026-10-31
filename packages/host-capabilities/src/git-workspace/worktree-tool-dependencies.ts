import { realpath } from 'node:fs/promises';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { gitRefused } from './git-failure.ts';
import {
  createShellCorrelation,
  type ShellWorktreeCorrelation,
} from './shell-worktree-correlation.ts';
import type { WorktreeService } from './worktree-service.ts';
import type { WorktreeToolCapability } from './worktree-tools.ts';

/** The host's worktree services, which each run borrows under its own identity. */
export interface HostWorktreeServices {
  /**
   * The canonical roots a standalone host was launched on. Its runs hold them
   * without a workspace binding, so the active-run guard cannot see them:
   * archiving one is refused instead.
   */
  readonly launchRootPaths?: readonly string[] | undefined;
  /** Opens a worktree an agent created as a workspace folder (ADR-0028 step 3); desktop only. */
  readonly openWorktreeFolder?:
    | ((path: string) => Promise<{ displayName: string; path: string; rootId: string }>)
    | undefined;
  readonly resolveWorktreeService?: (() => WorktreeService | null) | undefined;
}

/** A worktree whose checkout is one of the host's launch roots; false when it is not recorded. */
async function isLaunchRootWorktree(
  service: WorktreeService,
  launchRootPaths: readonly string[],
  worktreeId: string
): Promise<BoundaryResult<boolean>> {
  const managed = await service.listManagedPaths();
  if (!managed.ok) {
    return managed;
  }
  const entry = managed.value.find((candidate) => candidate.id === worktreeId);
  if (!entry) {
    return { ok: true, value: false };
  }
  // Launch roots are canonical; a recorded path that no longer resolves is not one of them.
  const canonical = await realpath(entry.path).catch(() => entry.path);
  return { ok: true, value: launchRootPaths.includes(canonical) };
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
        archive: async (params) => {
          const launchRoots = services.launchRootPaths ?? [];
          if (launchRoots.length > 0) {
            const launchRoot = await isLaunchRootWorktree(service, launchRoots, params.worktreeId);
            if (!launchRoot.ok) {
              return launchRoot;
            }
            if (launchRoot.value) {
              return gitRefused(
                'conflict',
                'worktree.launch-root',
                'This worktree is a workspace root this host was launched on, and its runs use it, so it is not archived. Archive it from the desktop app or from a host launched on another folder.'
              );
            }
          }
          return await service.archive({ ...params, ...(runId ? { runId } : {}) });
        },
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
